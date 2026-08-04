const crypto = require("crypto");
const { DataAccessCenter } = require("../dataAccess");
const { requestInternalService } = require("../microModules");
const { emitSemanticEvent } = require("../observability/semanticEvents");

const RESPONSE_TERMINAL = new Set([
  "completed",
  "incomplete",
  "failed",
  "cancelled",
]);

function emitRecovery(run, outcome, metadata = {}) {
  try {
    emitSemanticEvent({
      eventId: crypto.randomUUID(),
      eventType: "agent.run.orphan-reconciled",
      category: "agent",
      severity: outcome === "unconfirmed" ? "warning" : "info",
      outcome,
      subject: {
        type: "agent-run",
        id: crypto
          .createHash("sha256")
          .update(String(run.invocationId))
          .digest("hex")
          .slice(0, 24),
        component: "agent-runtime",
        operation: "lease-reconcile",
      },
      impact: { scope: "agent-run", status: outcome },
      metadata,
      sensitivity: "metadata_only",
    });
  } catch {
    // Recovery must not depend on observability delivery.
  }
}

async function lookupResponseStatus(invocationId, env = process.env) {
  const baseUrl = String(env.ATHENA_RESPONSES_RUNTIME_URL || "").replace(
    /\/+$/,
    ""
  );
  if (!baseUrl) throw new Error("responses_runtime_url_missing");
  const result = await requestInternalService({
    callerRole: "agent-runtime",
    targetModule: "responses-runtime",
    capability: "responses.agent-run.status",
    contractVersion: "1.0",
    method: "GET",
    url: `${baseUrl}/internal/v1/responses/agent-runs/${encodeURIComponent(
      invocationId
    )}/status`,
    timeoutMs: Number(env.ATHENA_AGENT_RECOVERY_STATUS_TIMEOUT_MS || 5_000),
  });
  return result?.response || null;
}

async function reconcileExpiredAgentRuns({
  limit = 25,
  ownerId = `agent-recovery:${process.pid}`,
  leaseMs = 60_000,
  agentRuns = DataAccessCenter.agentRun,
  closeInvocation = (invocationId) =>
    DataAccessCenter.workspaceAgentInvocation.close(invocationId),
  responseStatus = lookupResponseStatus,
} = {}) {
  const expired = await agentRuns.expiredLeases({ limit });
  const results = [];
  for (const run of expired) {
    let result = { invocationId: run.invocationId, outcome: "unconfirmed" };
    try {
      if (run.finalChatId || run.finalPublicChatId) {
        await agentRuns.updateState(
          run.invocationId,
          {
            status: "completed",
            terminal: true,
            finalChatId: run.finalChatId,
            finalPublicChatId: run.finalPublicChatId,
          },
          ownerId
        );
        await closeInvocation(run.invocationId);
        result = { ...result, outcome: "completed_from_final_chat" };
      } else {
        const provider = await responseStatus(run.invocationId);
        if (!provider) {
          result = { ...result, outcome: "response_unconfirmed" };
        } else if (["completed", "incomplete"].includes(provider.status)) {
          await agentRuns.updateState(
            run.invocationId,
            {
              status: "stopped",
              terminal: true,
              errorCode: "agent_response_transport_lost",
            },
            ownerId
          );
          await closeInvocation(run.invocationId);
          result = {
            ...result,
            outcome: "stopped_transport_lost",
            responseStatus: provider.status,
          };
        } else if (["failed", "cancelled"].includes(provider.status)) {
          await agentRuns.updateState(
            run.invocationId,
            {
              status: provider.status === "failed" ? "failed" : "stopped",
              terminal: true,
              errorCode: provider.errorCode || `response_${provider.status}`,
            },
            ownerId
          );
          await closeInvocation(run.invocationId);
          result = {
            ...result,
            outcome: `closed_${provider.status}`,
            responseStatus: provider.status,
          };
        } else if (!RESPONSE_TERMINAL.has(provider.status)) {
          const claimed = await agentRuns.claim({
            invocationId: run.invocationId,
            ownerId,
            leaseMs,
          });
          result = {
            ...result,
            outcome: claimed?.claimed
              ? "provider_running_lease_recovered"
              : "provider_running_lease_owned",
            responseStatus: provider.status,
          };
        }
      }
    } catch (error) {
      result = {
        ...result,
        outcome: "unconfirmed",
        errorCode: error?.code || error?.message || "agent_recovery_failed",
      };
    }
    emitRecovery(run, result.outcome, {
      responseStatus: result.responseStatus,
      errorCode: result.errorCode,
    });
    results.push(result);
  }
  return { inspected: expired.length, results };
}

function startAgentRunRecovery({ env = process.env } = {}) {
  const intervalMs = Math.max(
    15_000,
    Number(env.ATHENA_AGENT_RECOVERY_INTERVAL_MS || 60_000)
  );
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await reconcileExpiredAgentRuns({
        limit: Number(env.ATHENA_AGENT_RECOVERY_BATCH_SIZE || 25),
      });
    } catch (error) {
      console.error("[AgentRunRecovery] scan failed", error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

module.exports = {
  lookupResponseStatus,
  reconcileExpiredAgentRuns,
  startAgentRunRecovery,
};
