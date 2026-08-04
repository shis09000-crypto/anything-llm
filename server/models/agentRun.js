const crypto = require("crypto");
const prisma = require("../utils/prisma");
const {
  decryptChatFieldCompat,
} = require("../utils/security/chatHistorySerialEncryption");
const {
  unwrapMaterial,
  wrapMaterial,
} = require("../utils/security/keyCustody/remoteClient");
const {
  throwModelDataAccessError,
} = require("../utils/dataAccess/modelErrors");

const DEFAULT_AGENT_LEASE_MS = 30_000;
const TERMINAL_AGENT_STATUSES = new Set([
  "completed",
  "failed",
  "stopped",
  "closed",
]);

const AGENT_RUN_EVENT_PURPOSE = "agent-run-event";

function resolveRunTransition(
  currentStatus,
  requestedStatus,
  terminal = false
) {
  const alreadyTerminal = TERMINAL_AGENT_STATUSES.has(currentStatus);
  return {
    alreadyTerminal,
    terminal: alreadyTerminal || Boolean(terminal),
    status: alreadyTerminal
      ? currentStatus
      : String(requestedStatus || currentStatus || "running").slice(0, 80),
  };
}

function agentRunEventContext(invocationId, operation) {
  return {
    purpose: AGENT_RUN_EVENT_PURPOSE,
    domain: "agent",
    resource: `agent-run:${String(invocationId)}`,
    operation,
  };
}

async function encryptAgentRunEvent(value, invocationId) {
  return wrapMaterial(
    String(value),
    agentRunEventContext(invocationId, "event-wrap")
  );
}

async function decryptAgentRunEvent(value, invocationId) {
  if (String(value || "").startsWith("enc:v2:")) {
    const parts = String(value).split(":");
    const purpose = parts[3]
      ? Buffer.from(parts[3], "base64url").toString("utf8")
      : "";
    if (purpose === AGENT_RUN_EVENT_PURPOSE) {
      return unwrapMaterial(
        value,
        agentRunEventContext(invocationId, "event-unwrap")
      );
    }
  }
  return decryptChatFieldCompat(value);
}

function runData(invocation, ownerId, leaseMs = DEFAULT_AGENT_LEASE_MS) {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    invocationId: String(invocation.uuid),
    clientTurnId: invocation.clientTurnId || null,
    workspaceId: Number(invocation.workspace_id),
    threadId:
      invocation.thread_id === null || invocation.thread_id === undefined
        ? null
        : Number(invocation.thread_id),
    userId:
      invocation.user_id === null || invocation.user_id === undefined
        ? null
        : Number(invocation.user_id),
    status: invocation.closed ? "closed" : "running",
    ownerId: ownerId ? String(ownerId) : null,
    heartbeatAt: ownerId ? now : null,
    leaseExpiresAt: ownerId
      ? new Date(now.getTime() + Math.max(5_000, Number(leaseMs) || 0))
      : null,
    completedAt: invocation.closed ? now : null,
  };
}

const AgentRun = {
  claim: async function ({
    invocationId,
    ownerId = null,
    leaseMs = DEFAULT_AGENT_LEASE_MS,
  } = {}) {
    const normalizedInvocationId = String(invocationId || "").trim();
    if (!normalizedInvocationId) {
      const error = new Error("agent_run_invocation_required");
      error.code = "agent_run_invocation_required";
      throw error;
    }
    try {
      return await prisma.$transaction(async (tx) => {
        const invocation = await tx.workspace_agent_invocations.findUnique({
          where: { uuid: normalizedInvocationId },
        });
        if (!invocation) return { run: null, claimed: false };
        const existing = await tx.agent_runs.findUnique({
          where: { invocationId: normalizedInvocationId },
        });
        if (!existing)
          return {
            run: await tx.agent_runs.create({
              data: runData(invocation, ownerId, leaseMs),
            }),
            claimed: true,
          };
        if (TERMINAL_AGENT_STATUSES.has(existing.status))
          return { run: existing, claimed: false };

        const ownedByCaller =
          ownerId && String(existing.ownerId || "") === String(ownerId);
        const leaseExpired =
          !existing.leaseExpiresAt ||
          Date.parse(existing.leaseExpiresAt) <= Date.now();
        if (existing.ownerId && !ownedByCaller && !leaseExpired)
          return { run: existing, claimed: false };

        return {
          run: await tx.agent_runs.update({
            where: { id: existing.id },
            data: {
              ownerId: ownerId ? String(ownerId) : existing.ownerId,
              heartbeatAt: ownerId ? new Date() : existing.heartbeatAt,
              leaseExpiresAt: ownerId
                ? new Date(Date.now() + Math.max(5_000, Number(leaseMs) || 0))
                : existing.leaseExpiresAt,
            },
          }),
          claimed: true,
        };
      });
    } catch (error) {
      if (error?.code === "P2002")
        return this.claim({ invocationId, ownerId, leaseMs });
      throwModelDataAccessError("agentRun.claim", error);
    }
  },

  ensure: async function (options = {}) {
    const result = await this.claim(options);
    return result.run;
  },

  append: async function ({
    invocationId,
    record,
    state = {},
    ownerId = null,
  } = {}) {
    if (!record?.seq || !record?.payload) return null;
    try {
      const invocation = await prisma.workspace_agent_invocations.findUnique({
        where: { uuid: String(invocationId) },
      });
      if (!invocation) return null;
      const run = await this.ensure({ invocationId, ownerId });
      if (!run) return null;
      const plaintext = JSON.stringify({
        seq: Number(record.seq),
        eventType: String(record.eventType || "unknown"),
        payload: record.payload,
        createdAt: record.createdAt,
        sensitivity: record.sensitivity || "metadata-only",
      });
      const payloadJson = await encryptAgentRunEvent(
        plaintext,
        invocation.uuid
      );
      const payloadHash = crypto
        .createHash("sha256")
        .update(plaintext)
        .digest("hex");
      const sequence = Number(record.seq);
      return await prisma.$transaction(async (tx) => {
        const existing = await tx.agent_run_events.findUnique({
          where: {
            runId_sequence: {
              runId: run.id,
              sequence,
            },
          },
        });
        if (!existing)
          await tx.agent_run_events.create({
            data: {
              runId: run.id,
              sequence,
              eventType: String(record.eventType || "unknown").slice(0, 120),
              payloadJson,
              payloadHash,
              sensitivity: String(record.sensitivity || "metadata-only").slice(
                0,
                80
              ),
            },
          });
        const currentRun = await tx.agent_runs.findUnique({
          where: { id: run.id },
        });
        const transition = resolveRunTransition(
          currentRun?.status,
          state.status,
          state.terminal
        );
        return tx.agent_runs.update({
          where: { id: run.id },
          data: {
            latestSequence: Math.max(
              Number(currentRun?.latestSequence || 0),
              sequence
            ),
            status: transition.status,
            finalChatId:
              state.finalChatId ||
              currentRun?.finalChatId ||
              run.finalChatId ||
              null,
            finalPublicChatId:
              state.finalPublicChatId ||
              currentRun?.finalPublicChatId ||
              run.finalPublicChatId ||
              null,
            errorCode: state.errorCode
              ? String(state.errorCode).slice(0, 160)
              : currentRun?.errorCode || run.errorCode,
            ownerId: transition.terminal
              ? null
              : ownerId || currentRun?.ownerId || run.ownerId,
            leaseExpiresAt: transition.terminal
              ? null
              : currentRun?.leaseExpiresAt || run.leaseExpiresAt,
            completedAt: transition.terminal
              ? currentRun?.completedAt || new Date()
              : currentRun?.completedAt || run.completedAt,
          },
        });
      });
    } catch (error) {
      throwModelDataAccessError("agentRun.append", error);
    }
  },

  state: async function (invocationId) {
    try {
      return await prisma.agent_runs.findUnique({
        where: { invocationId: String(invocationId) },
      });
    } catch (error) {
      throwModelDataAccessError("agentRun.state", error);
    }
  },

  eventsAfter: async function (invocationId, afterSequence = 0, limit = 500) {
    try {
      const run = await prisma.agent_runs.findUnique({
        where: { invocationId: String(invocationId) },
      });
      if (!run) return [];
      const invocation = await prisma.workspace_agent_invocations.findUnique({
        where: { uuid: String(invocationId) },
      });
      if (!invocation) return [];
      const rows = await prisma.agent_run_events.findMany({
        where: {
          runId: run.id,
          sequence: { gt: Math.max(0, Number(afterSequence) || 0) },
        },
        orderBy: { sequence: "asc" },
        take: Math.max(1, Math.min(Number(limit) || 500, 500)),
      });
      const events = [];
      for (const row of rows) {
        const plaintext = await decryptAgentRunEvent(
          row.payloadJson,
          invocationId
        );
        if (
          crypto.createHash("sha256").update(plaintext).digest("hex") !==
          row.payloadHash
        )
          throw new Error("agent_run_event_hash_mismatch");
        events.push(JSON.parse(plaintext));
      }
      return events;
    } catch (error) {
      throwModelDataAccessError("agentRun.eventsAfter", error);
    }
  },

  updateState: async function (invocationId, state = {}, ownerId = null) {
    try {
      const run = await this.ensure({ invocationId, ownerId });
      if (!run) return null;
      const transition = resolveRunTransition(
        run.status,
        state.status,
        state.terminal
      );
      return await prisma.agent_runs.update({
        where: { id: run.id },
        data: {
          status: transition.status,
          latestSequence: Math.max(
            Number(run.latestSequence || 0),
            Number(state.latestSeq || 0)
          ),
          finalChatId: state.finalChatId || run.finalChatId || null,
          finalPublicChatId:
            state.finalPublicChatId || run.finalPublicChatId || null,
          errorCode: state.errorCode
            ? String(state.errorCode).slice(0, 160)
            : run.errorCode,
          ownerId: transition.terminal ? null : ownerId || run.ownerId,
          leaseExpiresAt: transition.terminal ? null : run.leaseExpiresAt,
          completedAt: transition.terminal
            ? run.completedAt || new Date()
            : run.completedAt,
        },
      });
    } catch (error) {
      throwModelDataAccessError("agentRun.updateState", error);
    }
  },

  renewLease: async function (
    invocationId,
    ownerId,
    leaseMs = DEFAULT_AGENT_LEASE_MS
  ) {
    if (!ownerId) return false;
    try {
      const now = new Date();
      const result = await prisma.agent_runs.updateMany({
        where: {
          invocationId: String(invocationId),
          ownerId: String(ownerId),
          status: { notIn: [...TERMINAL_AGENT_STATUSES] },
        },
        data: {
          heartbeatAt: now,
          leaseExpiresAt: new Date(
            now.getTime() + Math.max(5_000, Number(leaseMs) || 0)
          ),
        },
      });
      return result.count > 0;
    } catch (error) {
      throwModelDataAccessError("agentRun.renewLease", error);
    }
  },
};

module.exports = {
  AgentRun,
  AGENT_RUN_EVENT_PURPOSE,
  DEFAULT_AGENT_LEASE_MS,
  TERMINAL_AGENT_STATUSES,
  _internals: {
    agentRunEventContext,
    decryptAgentRunEvent,
    encryptAgentRunEvent,
    resolveRunTransition,
  },
};
