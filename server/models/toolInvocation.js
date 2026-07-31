const crypto = require("crypto");
const prisma = require("../utils/prisma");
const { canonicalJson } = require("../utils/modulePlatform/canonical");
const {
  encryptWorkspaceChatFieldAsync,
} = require("../utils/security/chatHistoryEncryption");
const {
  throwModelDataAccessError,
} = require("../utils/dataAccess/modelErrors");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function bounded(value, max) {
  const normalized = String(value || "").trim();
  return normalized ? normalized.slice(0, max) : null;
}

function scopeForInvocation(invocation) {
  return {
    workspaceId: Number(invocation.workspace_id),
    threadId:
      invocation.thread_id === null ? null : Number(invocation.thread_id),
    userId: invocation.user_id === null ? null : Number(invocation.user_id),
    apiSessionId: null,
  };
}

function scopeDigest(value = {}) {
  return sha256(canonicalJson(value));
}

const ToolInvocation = {
  requestApproval: async function ({
    approvalRequestId,
    agentInvocationId,
    clientTurnId = null,
    ownerUserId = null,
    ownerAuthUserId = null,
    toolName,
    approvalClass = null,
    scope = {},
  } = {}) {
    const requestId = bounded(approvalRequestId, 160);
    const normalizedToolName = bounded(toolName, 160);
    if (!requestId || !normalizedToolName) {
      const error = new Error("tool_approval_request_invalid");
      error.code = "tool_approval_request_invalid";
      throw error;
    }
    try {
      const invocation = await prisma.workspace_agent_invocations.findUnique({
        where: { uuid: String(agentInvocationId || "") },
      });
      if (!invocation) {
        const error = new Error("tool_approval_agent_invocation_missing");
        error.code = "tool_approval_agent_invocation_missing";
        throw error;
      }
      if (
        ownerUserId !== null &&
        ownerUserId !== undefined &&
        Number(ownerUserId) !== Number(invocation.user_id)
      ) {
        const error = new Error("tool_approval_owner_mismatch");
        error.code = "tool_approval_owner_mismatch";
        throw error;
      }
      const owner =
        invocation.user_id === null
          ? null
          : await prisma.users.findUnique({
              where: { id: Number(invocation.user_id) },
              select: { authUserId: true },
            });
      if (
        ownerAuthUserId !== null &&
        ownerAuthUserId !== undefined &&
        String(ownerAuthUserId) !== String(owner?.authUserId || "")
      ) {
        const error = new Error("tool_approval_auth_owner_mismatch");
        error.code = "tool_approval_auth_owner_mismatch";
        throw error;
      }
      const digest = scopeDigest(scope);
      const scopeJson = await encryptWorkspaceChatFieldAsync(
        canonicalJson(scope),
        scopeForInvocation(invocation)
      );
      try {
        return await prisma.tool_invocations.create({
          data: {
            id: crypto.randomUUID(),
            approvalRequestId: requestId,
            agentInvocationId: invocation.uuid,
            clientTurnId:
              bounded(clientTurnId, 160) ||
              bounded(invocation.clientTurnId, 160),
            ownerUserId:
              ownerUserId === null || ownerUserId === undefined
                ? invocation.user_id
                : Number(ownerUserId),
            ownerAuthUserId: bounded(ownerAuthUserId ?? owner?.authUserId, 160),
            toolName: normalizedToolName,
            approvalClass: bounded(approvalClass, 120),
            status: "approval_requested",
            scopeJson,
            scopeHash: digest,
          },
        });
      } catch (error) {
        if (error?.code !== "P2002") throw error;
        const existing = await prisma.tool_invocations.findUnique({
          where: { approvalRequestId: requestId },
        });
        if (
          !existing ||
          existing.toolName !== normalizedToolName ||
          existing.scopeHash !== digest ||
          existing.agentInvocationId !== invocation.uuid
        ) {
          const conflict = new Error("tool_approval_request_conflict");
          conflict.code = "tool_approval_request_conflict";
          throw conflict;
        }
        return existing;
      }
    } catch (error) {
      throwModelDataAccessError("toolInvocation.requestApproval", error);
    }
  },

  resolveApproval: async function ({
    approvalRequestId,
    approved,
    reasonCode = null,
  } = {}) {
    try {
      const result = await prisma.tool_invocations.updateMany({
        where: {
          approvalRequestId: String(approvalRequestId),
          status: "approval_requested",
        },
        data: {
          status: approved ? "approved" : "denied",
          approvedAt: approved ? new Date() : null,
          completedAt: approved ? null : new Date(),
          reasonCode: approved ? null : bounded(reasonCode, 160),
        },
      });
      if (result.count > 0) return true;
      const existing = await prisma.tool_invocations.findUnique({
        where: { approvalRequestId: String(approvalRequestId) },
      });
      return Boolean(
        existing &&
          (approved
            ? ["approved", "running", "completed"].includes(existing.status)
            : existing.status === "denied")
      );
    } catch (error) {
      throwModelDataAccessError("toolInvocation.resolveApproval", error);
    }
  },

  startExecution: async function ({
    approvalRequestId,
    agentInvocationId,
    toolName,
    scope = {},
    args = {},
  } = {}) {
    try {
      const result = await prisma.tool_invocations.updateMany({
        where: {
          approvalRequestId: String(approvalRequestId),
          agentInvocationId: String(agentInvocationId),
          toolName: String(toolName),
          scopeHash: scopeDigest(scope),
          status: "approved",
        },
        data: {
          status: "running",
          argumentHash: sha256(canonicalJson(args)),
          startedAt: new Date(),
          reasonCode: null,
        },
      });
      if (result.count !== 1) {
        const error = new Error("tool_invocation_capability_scope_denied");
        error.code = "tool_invocation_capability_scope_denied";
        throw error;
      }
      return prisma.tool_invocations.findUnique({
        where: { approvalRequestId: String(approvalRequestId) },
      });
    } catch (error) {
      throwModelDataAccessError("toolInvocation.startExecution", error);
    }
  },

  startAutomaticExecution: async function ({
    agentInvocationId,
    clientTurnId = null,
    ownerUserId = null,
    toolName,
    approvalClass = "automatic",
    scope = {},
    args = {},
  } = {}) {
    const approvalRequestId = `automatic:${crypto.randomUUID()}`;
    await this.requestApproval({
      approvalRequestId,
      agentInvocationId,
      clientTurnId,
      ownerUserId,
      toolName,
      approvalClass,
      scope,
    });
    await this.resolveApproval({ approvalRequestId, approved: true });
    await this.startExecution({
      approvalRequestId,
      agentInvocationId,
      toolName,
      scope,
      args,
    });
    return { approvalRequestId };
  },

  completeExecution: async function ({ approvalRequestId, result } = {}) {
    try {
      const resultHash = sha256(
        typeof result === "string" ? result : canonicalJson(result)
      );
      const updated = await prisma.tool_invocations.updateMany({
        where: {
          approvalRequestId: String(approvalRequestId),
          status: "running",
        },
        data: {
          status: "completed",
          resultHash,
          completedAt: new Date(),
        },
      });
      return updated.count === 1;
    } catch (error) {
      throwModelDataAccessError("toolInvocation.completeExecution", error);
    }
  },

  failExecution: async function ({ approvalRequestId, reasonCode } = {}) {
    try {
      const result = await prisma.tool_invocations.updateMany({
        where: {
          approvalRequestId: String(approvalRequestId),
          status: { in: ["approval_requested", "approved", "running"] },
        },
        data: {
          status: "failed",
          reasonCode: bounded(reasonCode, 160) || "tool_invocation_failed",
          completedAt: new Date(),
        },
      });
      return result.count > 0;
    } catch (error) {
      throwModelDataAccessError("toolInvocation.failExecution", error);
    }
  },

  executionContext: async function ({
    approvalRequestId,
    toolName,
    args = {},
    approvalClass = null,
  } = {}) {
    try {
      const invocation = await prisma.tool_invocations.findUnique({
        where: { approvalRequestId: String(approvalRequestId || "") },
      });
      if (
        !invocation ||
        invocation.status !== "running" ||
        invocation.toolName !== String(toolName || "") ||
        invocation.argumentHash !== sha256(canonicalJson(args)) ||
        (approvalClass && invocation.approvalClass !== String(approvalClass)) ||
        !Number.isSafeInteger(Number(invocation.ownerUserId)) ||
        !invocation.ownerAuthUserId
      ) {
        const error = new Error("tool_invocation_execution_context_denied");
        error.code = "tool_invocation_execution_context_denied";
        throw error;
      }
      const owner = await prisma.users.findUnique({
        where: { id: Number(invocation.ownerUserId) },
        select: { id: true, authUserId: true },
      });
      if (
        !owner ||
        String(owner.authUserId || "") !== invocation.ownerAuthUserId
      ) {
        const error = new Error("tool_invocation_owner_changed");
        error.code = "tool_invocation_owner_changed";
        throw error;
      }
      const agentInvocation =
        await prisma.workspace_agent_invocations.findUnique({
          where: { uuid: invocation.agentInvocationId || "" },
          select: { workspace_id: true, thread_id: true },
        });
      if (!agentInvocation) {
        const error = new Error("tool_invocation_agent_context_missing");
        error.code = "tool_invocation_agent_context_missing";
        throw error;
      }
      return {
        id: invocation.id,
        approvalRequestId: invocation.approvalRequestId,
        agentInvocationId: invocation.agentInvocationId,
        ownerUserId: owner.id,
        ownerAuthUserId: owner.authUserId,
        toolName: invocation.toolName,
        approvalClass: invocation.approvalClass,
        scopeHash: invocation.scopeHash,
        argumentHash: invocation.argumentHash,
        approvedAt: invocation.approvedAt,
        startedAt: invocation.startedAt,
        workspaceId: Number(agentInvocation.workspace_id),
        threadId:
          agentInvocation.thread_id === null
            ? null
            : Number(agentInvocation.thread_id),
      };
    } catch (error) {
      throwModelDataAccessError("toolInvocation.executionContext", error);
    }
  },

  consumeCapabilityNonce: async function ({
    nonce,
    toolInvocationId = null,
    audience,
    toolName,
    argsHash,
    capabilityHash,
    expiresAt,
  } = {}) {
    try {
      await prisma.plugin_capability_nonces.create({
        data: {
          id: crypto.randomUUID(),
          nonceHash: sha256(nonce),
          toolInvocationId: bounded(toolInvocationId, 160),
          audience: bounded(audience, 240),
          toolName: bounded(toolName, 160),
          argsHash: String(argsHash),
          capabilityHash: String(capabilityHash),
          expiresAt: new Date(expiresAt),
        },
      });
      return true;
    } catch (error) {
      if (error?.code === "P2002") {
        const replay = new Error("plugin_capability_nonce_replayed");
        replay.code = "PLUGIN_CAPABILITY_NONCE_REPLAYED";
        throw replay;
      }
      throwModelDataAccessError("toolInvocation.consumeCapabilityNonce", error);
    }
  },

  pruneCapabilityNonces: async function ({ before = new Date() } = {}) {
    try {
      const result = await prisma.plugin_capability_nonces.deleteMany({
        where: { expiresAt: { lt: new Date(before) } },
      });
      return result.count;
    } catch (error) {
      throwModelDataAccessError("toolInvocation.pruneCapabilityNonces", error);
    }
  },
};

module.exports = {
  ToolInvocation,
  scopeDigest,
  sha256,
};
