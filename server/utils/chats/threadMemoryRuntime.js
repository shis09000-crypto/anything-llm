const { DataAccessCenter } = require("../dataAccess");
const {
  compactThread,
  getThreadCompactionStatus,
  recentChatHistoryWithCompaction,
} = require("./threadCompaction");
const {
  remoteKeyCustodyEnabled,
  unwrapMaterial,
  wrapMaterial,
} = require("../security/keyCustody/remoteClient");

const Workspace = DataAccessCenter.workspace;
const WorkspaceThread = DataAccessCenter.workspaceThread;
const readiness = {
  ready: false,
  keyCustody: "unchecked",
  checkedAt: null,
  reasonCode: "thread_memory_not_initialized",
};
const compactReceipts = new Map();
const COMPACT_RECEIPT_TTL_MS = 5 * 60 * 1000;

function publicReadiness() {
  return { ...readiness };
}

async function threadMemoryKeyCustodySelfTest(env = process.env) {
  if (!remoteKeyCustodyEnabled(env)) {
    Object.assign(readiness, {
      ready: true,
      keyCustody: "local",
      checkedAt: new Date().toISOString(),
      reasonCode: null,
    });
    return publicReadiness();
  }

  const marker = `thread-memory-self-test:${Date.now()}`;
  const context = {
    purpose: "thread-compaction-memory",
    domain: "thread-compaction-memory",
    operation: "thread-memory-startup-self-test",
    resource: "thread-memory-readiness-canary",
  };
  try {
    const wrapped = await wrapMaterial(marker, context, env);
    const unwrapped = await unwrapMaterial(wrapped, context, env);
    if (unwrapped !== marker) {
      const error = new Error("thread_memory_key_custody_self_test_mismatch");
      error.code = "thread_memory_key_custody_self_test_mismatch";
      throw error;
    }
    Object.assign(readiness, {
      ready: true,
      keyCustody: "remote_verified",
      checkedAt: new Date().toISOString(),
      reasonCode: null,
    });
    return publicReadiness();
  } catch (error) {
    const raw = [error?.code, error?.reasonCode, error?.message]
      .filter(Boolean)
      .join(":")
      .toLowerCase();
    const reasonCode = raw.includes("contract_fingerprint_mismatch")
      ? "thread_memory_contract_incompatible"
      : "thread_memory_decryption_unavailable";
    Object.assign(readiness, {
      ready: false,
      keyCustody: "failed",
      checkedAt: new Date().toISOString(),
      reasonCode,
    });
    const normalized = new Error(reasonCode, { cause: error });
    normalized.code = reasonCode;
    normalized.httpStatus = 503;
    throw normalized;
  }
}

async function resolveSubjects(input = {}) {
  const workspaceId = Number(input.workspaceId);
  const threadId = Number(input.threadId);
  const userId =
    input.userId === null || input.userId === undefined
      ? null
      : Number(input.userId);
  if (!Number.isInteger(workspaceId) || !Number.isInteger(threadId)) {
    const error = new Error("thread_memory_scope_invalid");
    error.code = "thread_memory_scope_invalid";
    error.httpStatus = 400;
    throw error;
  }
  const workspace = await Workspace.get({ id: workspaceId });
  const thread = await WorkspaceThread.get({
    id: threadId,
    workspace_id: workspaceId,
    ...(userId === null ? {} : { user_id: userId }),
  });
  if (!workspace || !thread) {
    const error = new Error("thread_memory_scope_not_found");
    error.code = "thread_memory_scope_not_found";
    error.httpStatus = 404;
    throw error;
  }
  return {
    workspace,
    thread,
    user: userId === null ? null : { id: userId },
    apiSessionId: input.apiSessionId || null,
  };
}

async function status(input = {}) {
  const subjects = await resolveSubjects(input);
  return getThreadCompactionStatus({
    ...subjects,
    historyRevision: input.historyRevision ?? subjects.thread.historyRevision,
  });
}

async function compact(input = {}) {
  const sourceActionId = String(input.sourceActionId || "")
    .trim()
    .slice(0, 160);
  if (!sourceActionId) {
    const error = new Error("thread_memory_idempotency_key_required");
    error.code = "thread_memory_idempotency_key_required";
    error.httpStatus = 400;
    throw error;
  }
  const now = Date.now();
  for (const [key, receipt] of compactReceipts) {
    if (receipt.expiresAt <= now) compactReceipts.delete(key);
  }
  const receiptKey = [
    sourceActionId,
    Number(input.workspaceId),
    Number(input.threadId),
    input.userId ?? "null",
  ].join(":");
  const existing = compactReceipts.get(receiptKey);
  if (existing) return existing.promise;

  const promise = (async () => {
    const subjects = await resolveSubjects(input);
    return compactThread({
      ...subjects,
      force: Boolean(input.force),
      reason: "manual",
      mode: input.mode || "target",
      targetRatio: input.targetRatio,
      compactInstructions: input.compactInstructions || "",
    });
  })().catch((error) => {
    compactReceipts.delete(receiptKey);
    throw error;
  });
  compactReceipts.set(receiptKey, {
    promise,
    expiresAt: now + COMPACT_RECEIPT_TTL_MS,
  });
  return promise;
}

async function contextResolve(input = {}) {
  const subjects = await resolveSubjects(input);
  return recentChatHistoryWithCompaction({
    ...subjects,
    messageLimit: Math.min(Math.max(Number(input.messageLimit) || 20, 1), 100),
    historyStrategy: input.historyStrategy || null,
  });
}

function sendFailure(response, error) {
  const reasonCode = String(
    error?.code || error?.message || "thread_memory_store_unavailable"
  );
  response.status(Number(error?.httpStatus) || 500).json({
    success: false,
    error: reasonCode,
    reasonCode,
    status: {
      state: "degraded",
      reasonCode,
    },
  });
}

function registerThreadMemoryRoutes(app) {
  app.post("/internal/v1/chat/memory/status", async (request, response) => {
    try {
      response.json({ success: true, status: await status(request.body) });
    } catch (error) {
      sendFailure(response, error);
    }
  });
  app.post("/internal/v1/chat/memory/compact", async (request, response) => {
    try {
      const result = await compact(request.body);
      response.status(result?.recoverable ? 503 : 200).json({
        success: result?.success === true,
        result,
        ...(result?.error ? { error: result.error } : {}),
      });
    } catch (error) {
      sendFailure(response, error);
    }
  });
  app.post(
    "/internal/v1/chat/memory/context/resolve",
    async (request, response) => {
      try {
        response.json({
          success: true,
          context: await contextResolve(request.body),
        });
      } catch (error) {
        sendFailure(response, error);
      }
    }
  );
}

module.exports = {
  compact,
  contextResolve,
  publicReadiness,
  registerThreadMemoryRoutes,
  status,
  threadMemoryKeyCustodySelfTest,
};
