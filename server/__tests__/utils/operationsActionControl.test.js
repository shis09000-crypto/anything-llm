/* eslint-env jest */

const {
  ACTION_IDS,
  actionCatalog,
  actionDefinition,
} = require("../../utils/operations/actions/catalog");
const {
  OperationsActionOrchestrator,
} = require("../../utils/operations/actions/orchestrator");
const {
  securityCacheAdapter,
} = require("../../utils/operations/actions/adapters");

function memoryRepository() {
  const runs = new Map();
  const approvals = [];
  return {
    async createRun(data) {
      const row = { ...data, createdAt: new Date(), updatedAt: new Date() };
      runs.set(row.id, row);
      return { ...row };
    },
    async getRun(id) {
      return runs.has(id) ? { ...runs.get(id) } : null;
    },
    async getRunBySourceActionId(sourceActionId) {
      return (
        [...runs.values()].find(
          (row) => row.sourceActionId === sourceActionId
        ) || null
      );
    },
    async listRuns({ actionId, status, statuses = [] } = {}) {
      return [...runs.values()].filter(
        (row) =>
          (!actionId || row.actionId === actionId) &&
          (!status || row.status === status) &&
          (!statuses.length || statuses.includes(row.status))
      );
    },
    async transitionRun({ id, from, to, data = {} }) {
      const row = runs.get(id);
      if (!row || !from.includes(row.status)) {
        const error = new Error("operations_action_state_conflict");
        error.code = "operations_action_state_conflict";
        throw error;
      }
      const next = { ...row, ...data, status: to, updatedAt: new Date() };
      runs.set(id, next);
      return { ...next };
    },
    async updateRun(id, data) {
      const next = { ...runs.get(id), ...data };
      runs.set(id, next);
      return { ...next };
    },
    async addApproval(entry) {
      approvals.push({ ...entry });
      return entry;
    },
    async approvalsForRun(runId) {
      return approvals.filter((entry) => entry.runId === runId);
    },
    async acquireLease({ runId, leaseOwner = "test-lease" }) {
      const row = runs.get(runId);
      if (!row) return false;
      runs.set(runId, {
        ...row,
        leaseOwner,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
      return true;
    },
    async releaseLease(runId) {
      const row = runs.get(runId);
      if (row)
        runs.set(runId, { ...row, leaseOwner: null, leaseExpiresAt: null });
      return { count: 1 };
    },
    async expiredLeasedRuns({ statuses = [], now = new Date() } = {}) {
      return [...runs.values()].filter(
        (row) =>
          statuses.includes(row.status) &&
          row.leaseOwner &&
          row.leaseExpiresAt &&
          row.leaseExpiresAt <= now
      );
    },
  };
}

function harness(adapter) {
  const repository = memoryRepository();
  const emit = jest.fn();
  const audit = jest.fn(async () => ({ spooled: false }));
  const orchestrator = new OperationsActionOrchestrator({
    repository,
    adapters: { [ACTION_IDS.REQUEUE_FAILED_TASKS]: adapter },
    env: { ATHENA_OPERATIONS_ACTIONS_ENABLED: "true" },
    emit,
    audit,
  });
  return { repository, orchestrator, emit, audit };
}

describe("Operations Action control plane", () => {
  test("catalog is a fixed allowlist and rejects arbitrary worker targets", () => {
    expect(actionCatalog().map((entry) => entry.id)).toEqual([
      ACTION_IDS.REQUEUE_FAILED_TASKS,
      ACTION_IDS.REFRESH_SECURITY_CACHE,
      ACTION_IDS.RESTART_STATELESS_WORKER,
      ACTION_IDS.REBUILD_WORKSPACE_INDEX,
    ]);
    expect(() =>
      actionDefinition(ACTION_IDS.RESTART_STATELESS_WORKER).sanitize({
        workerId: "shell:docker-restart",
      })
    ).toThrow("operations_worker_not_allowlisted");
  });

  test("runs dry-run, explicit approval, canary, execution and validation", async () => {
    const adapter = {
      preflight: jest.fn(async () => ({ targets: [{ seq: 9 }] })),
      canary: jest.fn(async () => ({ seqs: [9] })),
      validateCanary: jest.fn(async () => ({ valid: true })),
      execute: jest.fn(async () => ({ seqs: [9] })),
      validate: jest.fn(async () => ({ valid: true })),
      rollback: jest.fn(async () => ({ restored: 1 })),
    };
    const { orchestrator } = harness(adapter);
    const actor = { type: "human", role: "admin", userId: 7 };
    const proposed = await orchestrator.propose({
      actionId: ACTION_IDS.REQUEUE_FAILED_TASKS,
      parameters: { seqs: [9] },
      sourceActionId: "ops_test_success",
      actor,
    });
    expect(proposed.status).toBe("awaiting_approval");
    const approved = await orchestrator.decide({
      runId: proposed.id,
      decision: "approved",
      actor,
    });
    expect(approved.status).toBe("approved");
    const completed = await orchestrator.execute(proposed.id, actor);
    expect(completed.status).toBe("succeeded");
    expect(adapter.canary).toHaveBeenCalledTimes(1);
    expect(adapter.execute).toHaveBeenCalledTimes(1);
    expect(adapter.rollback).not.toHaveBeenCalled();
  });

  test("failed canary validation automatically rolls back", async () => {
    const adapter = {
      preflight: jest.fn(async () => ({ targets: [{ seq: 10 }] })),
      canary: jest.fn(async () => ({ seqs: [10] })),
      validateCanary: jest.fn(async () => ({ valid: false })),
      execute: jest.fn(),
      validate: jest.fn(),
      rollback: jest.fn(async () => ({ restored: 1 })),
    };
    const { orchestrator } = harness(adapter);
    const actor = { type: "human", role: "admin", userId: 8 };
    const run = await orchestrator.propose({
      actionId: ACTION_IDS.REQUEUE_FAILED_TASKS,
      parameters: { seqs: [10] },
      sourceActionId: "ops_test_rollback",
      actor,
    });
    await orchestrator.decide({
      runId: run.id,
      decision: "approved",
      actor,
    });
    const completed = await orchestrator.execute(run.id, actor);
    expect(completed.status).toBe("rolled_back");
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(adapter.rollback).toHaveBeenCalledTimes(1);
  });

  test("agent proposals cannot approve or execute actions", async () => {
    const adapter = {
      preflight: jest.fn(async () => ({ targets: [{ seq: 11 }] })),
    };
    const { orchestrator } = harness(adapter);
    const run = await orchestrator.propose({
      actionId: ACTION_IDS.REQUEUE_FAILED_TASKS,
      parameters: { seqs: [11] },
      sourceActionId: "ops_agent_proposal",
      actor: { type: "agent", agentId: "ops.rca" },
    });
    await expect(
      orchestrator.decide({
        runId: run.id,
        decision: "approved",
        actor: { type: "agent", agentId: "ops.rca" },
      })
    ).rejects.toThrow("operations_human_control_required");
    await expect(
      orchestrator.execute(run.id, { type: "agent", agentId: "ops.rca" })
    ).rejects.toThrow("operations_human_control_required");
  });

  test("ordinary human actors are denied inside the policy core", async () => {
    const { orchestrator } = harness({
      preflight: jest.fn(async () => ({ targets: [{ seq: 12 }] })),
    });
    await expect(
      orchestrator.propose({
        actionId: ACTION_IDS.REQUEUE_FAILED_TASKS,
        parameters: { seqs: [12] },
        sourceActionId: "ops_user_denied",
        actor: { type: "human", role: "default", userId: 12 },
      })
    ).rejects.toThrow("operations_admin_permission_required");
  });

  test("selected-session canary never turns the final stage into a global clear", async () => {
    const refreshCache = jest.fn(() => ({ scope: "selected" }));
    const adapter = securityCacheAdapter({
      data: {
        adminSystem: {
          authSession: {
            cacheSnapshot: () => ({ sessionEntries: 2, lastSeenEntries: 2 }),
            refreshCache,
          },
        },
      },
    });
    const dryRun = await adapter.preflight({
      parameters: { sessionIds: ["session-a"] },
    });
    await adapter.canary({ dryRun });
    await adapter.execute({ dryRun });
    expect(refreshCache).toHaveBeenCalledTimes(1);
    expect(refreshCache).toHaveBeenCalledWith({ sessionIds: ["session-a"] });
  });

  test("expired execution is quarantined until a human reconciles rollback", async () => {
    const adapter = {
      preflight: jest.fn(async () => ({ targets: [{ seq: 13 }] })),
      canary: jest.fn(),
      validateCanary: jest.fn(),
      execute: jest.fn(),
      validate: jest.fn(),
      rollback: jest.fn(async ({ recovery }) => ({ restored: recovery })),
    };
    const { orchestrator, repository } = harness(adapter);
    const actor = { type: "human", role: "admin", userId: 13 };
    const run = await orchestrator.propose({
      actionId: ACTION_IDS.REQUEUE_FAILED_TASKS,
      parameters: { seqs: [13] },
      sourceActionId: "ops_interrupted_recovery",
      actor,
    });
    await orchestrator.decide({
      runId: run.id,
      decision: "approved",
      actor,
    });
    await repository.transitionRun({
      id: run.id,
      from: ["approved"],
      to: "executing",
      data: {
        leaseOwner: "dead-process",
        leaseExpiresAt: new Date(Date.now() - 1_000),
      },
    });

    const scan = await orchestrator.markExpiredRunsForReconciliation();
    expect(scan.marked).toEqual([run.id]);
    expect((await repository.getRun(run.id)).status).toBe(
      "reconciliation_required"
    );

    await expect(
      orchestrator.reconcile(run.id, {
        type: "agent",
        agentId: "ops.rca",
      })
    ).rejects.toThrow("operations_human_control_required");
    const recovered = await orchestrator.reconcile(run.id, actor);
    expect(recovered.status).toBe("rolled_back");
    expect(adapter.rollback).toHaveBeenCalledWith(
      expect.objectContaining({ recovery: true })
    );
  });
});
