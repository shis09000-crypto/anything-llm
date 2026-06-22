const { v4: uuidv4 } = require("uuid");
const { writeResponseChunk } = require("../helpers/chat/responses");

const CHAT_TOOL_APPROVAL_TIMEOUT_MS = 120 * 1_000;
const pendingApprovals = new Map();

function requestChatToolApproval({
  response,
  userId,
  skillName,
  payload = {},
  description = null,
  allowAlwaysAllow = false,
  timeoutMs = CHAT_TOOL_APPROVAL_TIMEOUT_MS,
}) {
  const requestId = uuidv4();

  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      pendingApprovals.delete(requestId);
      resolve({
        requestId,
        approved: false,
        message: "Tool approval request timed out.",
        reason: "timeout",
      });
    }, timeoutMs);

    pendingApprovals.set(requestId, {
      userId: Number(userId) || null,
      resolve: (approved) => {
        clearTimeout(timeoutId);
        pendingApprovals.delete(requestId);
        resolve({
          requestId,
          approved: Boolean(approved),
          message: approved
            ? "User approved the tool execution."
            : "Tool call was rejected by the user.",
        });
      },
    });

    writeResponseChunk(response, {
      type: "toolApprovalRequest",
      requestId,
      skillName,
      payload,
      description,
      allowAlwaysAllow,
      timeoutMs,
    });
  });
}

function respondToChatToolApproval({ requestId, userId, approved }) {
  const pending = pendingApprovals.get(requestId);
  if (!pending) return { success: false, error: "Approval request not found." };
  if (pending.userId && Number(userId) !== pending.userId) {
    return { success: false, error: "Approval request is not owned by user." };
  }

  pending.resolve(Boolean(approved));
  return { success: true };
}

module.exports = {
  CHAT_TOOL_APPROVAL_TIMEOUT_MS,
  requestChatToolApproval,
  respondToChatToolApproval,
};
