const crypto = require("crypto");
const os = require("os");
const { DataAccessCenter } = require("../../dataAccess");
const { appendSecurityAuditDurably } = require("../../security/auditLedger");
const { emitSemanticEvent } = require("../../observability/semanticEvents");
const { metrics } = require("../../observability/metrics");
const { actionAdapters } = require("./adapters");
const { actionCatalog, actionDefinition, actionError } = require("./catalog");
const {
  actionsEnabled,
  approvalDecision,
  assertActorPermission,
  assertHumanControl,
  conflictingRun,
  evaluateProposal,
} = require("./policyEngine");

const LEASE_OWNER = `operations-actions:${os.hostname()}:${process.pid}`;

function safeSourceActionId(value) {
  const candidate = String(value || "").trim();
  if (!candidate) return `ops_${crypto.randomUUID()}`;
  if (!/^[A-Za-z0-9_.:-]{8,160}$/.test(candidate))
    throw actionError("operations_source_action_id_invalid");
  return candidate;
}

function actorMetadata(actor = {}) {
  return {
    type: ["agent", "system"].includes(actor.type) ? actor.type : "human",
    id: actor.userId ? String(actor.userId) : actor.agentId || null,
  };
}

function validationError(stage, validation = {}) {
  const error = actionError(`operations_${stage}_validation_failed`);
  error.details = validation;
  return error;
}

class OperationsActionOrchestrator {
  constructor({
    repository = DataAccessCenter.operationsAction,
    adapters = actionAdapters(),
    env = process.env,
    emit = emitSemanticEvent,
    audit = appendSecurityAuditDurably,
  } = {}) {
    this.repository = repository;
    this.adapters = adapters;
    this.env = env;
    this.emit = emit;
    this.audit = audit;
  }

  catalog() {
    return actionCatalog();
  }

  async record(run, stage, outcome, actor = {}, extra = {}) {
    const eventType = `operations.action.${stage}`;
    metrics.operationsActionStages?.inc({
      action: run.actionId,
      stage,
      outcome,
    });
    this.emit({
      eventType,
      category: "operations_control",
      severity: outcome === "failed" ? "error" : "info",
      outcome,
      subject: {
        type: "operations-action-run",
        id: run.id,
        component: run.actionId,
        operation: stage,
      },
      actor: actorMetadata(actor),
      correlation: { sourceActionId: run.sourceActionId },
      stateTransition: extra.stateTransition,
      recommendation: {
        actionId: run.actionId,
        risk: run.riskLevel,
        permission: "admin",
      },
      metadata: { errorCode: extra.errorCode || null },
      sensitivity: "metadata_only",
    });
    await this.audit({
      event: eventType,
      userId: Number(actor.userId) || null,
      requestId: actor.requestId || null,
      traceId: actor.traceId || null,
      metadata: {
        runId: run.id,
        actionId: run.actionId,
        sourceActionId: run.sourceActionId,
        stage,
        outcome,
        riskLevel: run.riskLevel,
        errorCode: extra.errorCode || null,
      },
    });
  }

  async propose({ actionId, parameters = {}, sourceActionId, actor = {} }) {
    const definition = actionDefinition(actionId);
    if (!definition) throw actionError("operations_action_not_cataloged");
    const requestedByType = actor.type === "agent" ? "agent" : "human";
    assertActorPermission(actor, definition.requiredPermission);
    const policy = evaluateProposal({
      definition,
      requestedByType,
      env: this.env,
    });
    if (policy.decision !== "allow")
      throw actionError(policy.reasons[0] || "operations_action_denied");
    const sanitized = definition.sanitize(parameters);
    const scope = definition.scope(sanitized);
    const idempotencyKey = safeSourceActionId(sourceActionId);
    const duplicate =
      await this.repository.getRunBySourceActionId(idempotencyKey);
    if (duplicate) return duplicate;
    const existing = await this.repository.listRuns({
      actionId: definition.id,
      limit: 500,
    });
    const conflict = conflictingRun(existing, scope);
    if (conflict) {
      const error = actionError("operations_action_scope_busy");
      error.runId = conflict.id;
      throw error;
    }
    let run = await this.repository.createRun({
      id: `oprun_${crypto.randomUUID()}`,
      sourceActionId: idempotencyKey,
      actionId: definition.id,
      actionVersion: definition.version,
      riskLevel: definition.riskLevel,
      status: "proposed",
      requestedBy: Number(actor.userId) || null,
      requestedByType,
      scope,
      parameters: sanitized,
      policy,
    });
    await this.record(run, "proposed", "accepted", actor);
    try {
      const adapter = this.adapters[definition.id];
      if (!adapter) throw actionError("operations_action_adapter_missing");
      const dryRun = await adapter.preflight({
        run,
        parameters: sanitized,
        actor,
      });
      run = await this.repository.transitionRun({
        id: run.id,
        from: ["proposed"],
        to: "awaiting_approval",
        data: { dryRun },
      });
      await this.record(run, "preflight", "passed", actor, {
        stateTransition: {
          from: "proposed",
          to: "awaiting_approval",
          reasonCode: "dry_run_passed",
        },
      });
      return run;
    } catch (error) {
      run = await this.repository.transitionRun({
        id: run.id,
        from: ["proposed"],
        to: "blocked",
        data: {
          errorCode: String(error?.code || "operations_preflight_failed").slice(
            0,
            160
          ),
          completedAt: new Date(),
        },
      });
      await this.record(run, "preflight", "failed", actor, {
        errorCode: run.errorCode,
      });
      throw error;
    }
  }

  async decide({ runId, decision, reasonCode = null, actor = {} }) {
    assertHumanControl(actor.type || "human");
    const run = await this.repository.getRun(runId);
    if (!run) throw actionError("operations_action_run_not_found");
    assertActorPermission(actor, run.policy?.requiredPermission);
    if (run.status !== "awaiting_approval")
      throw actionError("operations_action_not_awaiting_approval");
    const normalizedDecision =
      decision === "rejected" ? "rejected" : "approved";
    await this.repository.addApproval({
      runId: run.id,
      approverUserId: actor.userId,
      decision: normalizedDecision,
      reasonCode,
    });
    const approvals = await this.repository.approvalsForRun(run.id);
    const result = approvalDecision({ policy: run.policy, approvals });
    if (result.rejected) {
      const rejected = await this.repository.transitionRun({
        id: run.id,
        from: ["awaiting_approval"],
        to: "rejected",
        data: { completedAt: new Date() },
      });
      await this.record(rejected, "approval", "rejected", actor);
      return rejected;
    }
    if (!result.ready) return { ...run, approvalCount: result.approvals };
    const approved = await this.repository.transitionRun({
      id: run.id,
      from: ["awaiting_approval"],
      to: "approved",
      data: { approvedAt: new Date() },
    });
    await this.record(approved, "approval", "approved", actor);
    return approved;
  }

  async execute(runId, actor = {}) {
    assertHumanControl(actor.type || "human");
    let run = await this.repository.getRun(runId);
    if (!run) throw actionError("operations_action_run_not_found");
    assertActorPermission(actor, run.policy?.requiredPermission);
    if (run.status !== "approved")
      throw actionError("operations_action_not_approved");
    const approvals = await this.repository.approvalsForRun(run.id);
    const approval = approvalDecision({ policy: run.policy, approvals });
    if (!approval.ready || approval.rejected)
      throw actionError("operations_action_approval_incomplete");
    const leased = await this.repository.acquireLease({
      runId: run.id,
      leaseOwner: LEASE_OWNER,
    });
    if (!leased) throw actionError("operations_action_already_running");
    const adapter = this.adapters[run.actionId];
    let canary = {};
    let result = {};
    const started = Date.now();
    try {
      run = await this.repository.transitionRun({
        id: run.id,
        from: ["approved"],
        to: "canary_running",
        data: { startedAt: new Date(), errorCode: null },
      });
      await this.record(run, "canary", "started", actor);
      canary = await adapter.canary({
        run,
        parameters: run.parameters,
        dryRun: run.dryRun,
        actor,
      });
      run = await this.repository.transitionRun({
        id: run.id,
        from: ["canary_running"],
        to: "canary_validating",
        data: { canary },
      });
      const canaryValidation = await adapter.validateCanary({
        run,
        parameters: run.parameters,
        dryRun: run.dryRun,
        canary,
        actor,
      });
      if (!canaryValidation?.valid)
        throw validationError("canary", canaryValidation);
      await this.record(run, "canary", "passed", actor);
      run = await this.repository.transitionRun({
        id: run.id,
        from: ["canary_validating"],
        to: "executing",
        data: { validation: { canary: canaryValidation } },
      });
      result = await adapter.execute({
        run,
        parameters: run.parameters,
        dryRun: run.dryRun,
        canary,
        actor,
      });
      run = await this.repository.transitionRun({
        id: run.id,
        from: ["executing"],
        to: "validating",
        data: { result },
      });
      const validation = await adapter.validate({
        run,
        parameters: run.parameters,
        dryRun: run.dryRun,
        canary,
        result,
        actor,
      });
      if (!validation?.valid) throw validationError("final", validation);
      run = await this.repository.transitionRun({
        id: run.id,
        from: ["validating"],
        to: "succeeded",
        data: {
          validation: { ...run.validation, final: validation },
          completedAt: new Date(),
        },
      });
      metrics.operationsActionDuration?.observe(
        { action: run.actionId, outcome: "succeeded" },
        (Date.now() - started) / 1_000
      );
      await this.record(run, "completed", "succeeded", actor);
      return run;
    } catch (error) {
      const errorCode = String(
        error?.code || "operations_action_execution_failed"
      ).slice(0, 160);
      if (error?.details?.rebuilt)
        result = { ...result, documentIds: error.details.rebuilt };
      run = await this.repository.getRun(run.id);
      try {
        run = await this.repository.transitionRun({
          id: run.id,
          from: [run.status],
          to: "rollback_running",
          data: { errorCode, result },
        });
        await this.record(run, "rollback", "started", actor, { errorCode });
        const rollback = await adapter.rollback({
          run,
          parameters: run.parameters,
          dryRun: run.dryRun,
          canary,
          result,
          actor,
        });
        run = await this.repository.transitionRun({
          id: run.id,
          from: ["rollback_running"],
          to: "rolled_back",
          data: {
            rollback,
            rolledBackAt: new Date(),
            completedAt: new Date(),
          },
        });
        metrics.operationsActionRollbacks?.inc({
          action: run.actionId,
          outcome: "succeeded",
        });
        metrics.operationsActionDuration?.observe(
          { action: run.actionId, outcome: "rolled_back" },
          (Date.now() - started) / 1_000
        );
        await this.record(run, "rollback", "succeeded", actor, { errorCode });
      } catch (rollbackError) {
        run = await this.repository.getRun(run.id);
        run = await this.repository.transitionRun({
          id: run.id,
          from: [run.status],
          to: "rollback_failed",
          data: {
            rollback: {
              errorCode: String(
                rollbackError?.code || "operations_rollback_failed"
              ).slice(0, 160),
            },
            completedAt: new Date(),
          },
        });
        metrics.operationsActionRollbacks?.inc({
          action: run.actionId,
          outcome: "failed",
        });
        await this.record(run, "rollback", "failed", actor, {
          errorCode: run.rollback.errorCode,
        });
      }
      return run;
    } finally {
      await this.repository.releaseLease(run.id, LEASE_OWNER).catch(() => null);
    }
  }

  async markExpiredRunsForReconciliation({ now = new Date() } = {}) {
    const interruptedStatuses = [
      "canary_running",
      "canary_validating",
      "executing",
      "validating",
      "rollback_running",
    ];
    const expired = await this.repository.expiredLeasedRuns({
      statuses: interruptedStatuses,
      now,
      limit: 500,
    });
    const actor = { type: "system" };
    const marked = [];
    for (const candidate of expired) {
      try {
        const run = await this.repository.transitionRun({
          id: candidate.id,
          from: [candidate.status],
          to: "reconciliation_required",
          data: {
            errorCode: "operations_action_interrupted",
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        });
        await this.record(
          run,
          "interrupted",
          "reconciliation_required",
          actor,
          {
            errorCode: run.errorCode,
            stateTransition: {
              from: candidate.status,
              to: "reconciliation_required",
              reasonCode: "execution_lease_expired",
            },
          }
        );
        marked.push(run.id);
      } catch (error) {
        if (error?.code !== "operations_action_state_conflict") throw error;
      }
    }
    return { inspected: expired.length, marked };
  }

  async reconcile(runId, actor = {}) {
    assertHumanControl(actor.type || "human");
    let run = await this.repository.getRun(runId);
    if (!run) throw actionError("operations_action_run_not_found");
    assertActorPermission(actor, run.policy?.requiredPermission);
    if (run.status !== "reconciliation_required")
      throw actionError("operations_action_not_reconciliation_required");
    const adapter = this.adapters[run.actionId];
    if (!adapter) throw actionError("operations_action_adapter_missing");
    const leased = await this.repository.acquireLease({
      runId: run.id,
      leaseOwner: LEASE_OWNER,
    });
    if (!leased) throw actionError("operations_action_already_running");
    try {
      run = await this.repository.transitionRun({
        id: run.id,
        from: ["reconciliation_required"],
        to: "rollback_running",
        data: { errorCode: "operations_action_interrupted" },
      });
      await this.record(run, "reconciliation", "rollback_started", actor);
      const rollback = await adapter.rollback({
        run,
        parameters: run.parameters,
        dryRun: run.dryRun,
        canary: run.canary,
        result: run.result,
        actor,
        recovery: true,
      });
      run = await this.repository.transitionRun({
        id: run.id,
        from: ["rollback_running"],
        to: "rolled_back",
        data: {
          rollback,
          rolledBackAt: new Date(),
          completedAt: new Date(),
        },
      });
      metrics.operationsActionRollbacks?.inc({
        action: run.actionId,
        outcome: "succeeded",
      });
      await this.record(run, "reconciliation", "rolled_back", actor);
      return run;
    } catch (error) {
      run = await this.repository.getRun(run.id);
      if (run?.status === "rollback_running") {
        run = await this.repository.transitionRun({
          id: run.id,
          from: ["rollback_running"],
          to: "rollback_failed",
          data: {
            rollback: {
              errorCode: String(
                error?.code || "operations_reconciliation_rollback_failed"
              ).slice(0, 160),
            },
            completedAt: new Date(),
          },
        });
        metrics.operationsActionRollbacks?.inc({
          action: run.actionId,
          outcome: "failed",
        });
        await this.record(run, "reconciliation", "rollback_failed", actor, {
          errorCode: run.rollback.errorCode,
        });
      }
      return run;
    } finally {
      await this.repository.releaseLease(run.id, LEASE_OWNER).catch(() => null);
    }
  }
}

class OperationsActionRuntime {
  constructor(orchestrator = new OperationsActionOrchestrator()) {
    this.orchestrator = orchestrator;
    this.inFlight = new Map();
    this.reconciliationTimer = null;
    this.lastReconciliationAt = null;
    this.reconciliationRequired = [];
  }

  async start() {
    if (!actionsEnabled(this.orchestrator.env)) return this.snapshot();
    await this.scanInterrupted();
    this.scheduleReconciliationScan();
    return this.snapshot();
  }

  async stop() {
    if (this.reconciliationTimer) clearTimeout(this.reconciliationTimer);
    this.reconciliationTimer = null;
    await Promise.allSettled(this.inFlight.values());
    return this.snapshot();
  }

  async scanInterrupted() {
    const result = await this.orchestrator.markExpiredRunsForReconciliation();
    const outstanding = await this.orchestrator.repository.listRuns({
      status: "reconciliation_required",
      limit: 500,
    });
    this.lastReconciliationAt = new Date().toISOString();
    this.reconciliationRequired = outstanding.map((run) => run.id);
    return { ...result, outstanding: this.reconciliationRequired };
  }

  scheduleReconciliationScan() {
    if (this.reconciliationTimer) return;
    this.reconciliationTimer = setTimeout(async () => {
      this.reconciliationTimer = null;
      await this.scanInterrupted().catch((error) =>
        console.error("[OperationsActions] reconciliation scan failed", {
          code: error?.code || "operations_reconciliation_scan_failed",
        })
      );
      this.scheduleReconciliationScan();
    }, 30_000);
    this.reconciliationTimer.unref?.();
  }

  executeAsync(runId, actor = {}) {
    const key = String(runId);
    if (this.inFlight.has(key)) return false;
    const task = this.orchestrator
      .execute(key, actor)
      .catch((error) =>
        console.error("[OperationsActions] execution failed", {
          runId: key,
          code: error?.code || "operations_action_execution_failed",
        })
      )
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return true;
  }

  snapshot() {
    return {
      inFlight: [...this.inFlight.keys()],
      lastReconciliationAt: this.lastReconciliationAt,
      reconciliationRequired: [...this.reconciliationRequired],
    };
  }
}

const operationsActionOrchestrator = new OperationsActionOrchestrator();
const operationsActionRuntime = new OperationsActionRuntime(
  operationsActionOrchestrator
);

module.exports = {
  LEASE_OWNER,
  OperationsActionOrchestrator,
  OperationsActionRuntime,
  operationsActionOrchestrator,
  operationsActionRuntime,
  safeSourceActionId,
};
