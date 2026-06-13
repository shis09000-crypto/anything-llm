const { makeJWT, decodeJWT } = require("./http");

const IDLE_TIMEOUT_MS = 48 * 60 * 60 * 1000;
const USER_ACTION_REFRESH_THROTTLE_MS = 60 * 1000;

const USER_ACTION_REASONS = Object.freeze({
  message_submit: "message_submit",
  file_upload: "file_upload",
  workspace_switch: "workspace_switch",
  thread_switch: "thread_switch",
  knowledge_open: "knowledge_open",
  page_navigation: "page_navigation",
  button_click: "button_click",
  security_action: "security_action",
});

const USER_ACTION_REASON_SET = new Set(Object.values(USER_ACTION_REASONS));

function isAllowedUserActionReason(reason) {
  return USER_ACTION_REASON_SET.has(reason);
}

function issueUserSessionToken(user, lastUserActionAt = Date.now()) {
  return makeJWT(
    {
      id: user.id,
      username: user.username,
      lastUserActionAt: Number(lastUserActionAt),
    },
    process.env.JWT_EXPIRY
  );
}

function jwtIdleState(decodedToken = {}) {
  const lastUserActionAt = tokenLastUserActionAt(decodedToken);
  const idleExpiresAt = lastUserActionAt + IDLE_TIMEOUT_MS;
  const idleRemainingMs = Math.max(0, idleExpiresAt - Date.now());
  return {
    lastUserActionAt,
    idleExpiresAt,
    idleRemainingMs,
    idleExpired: idleRemainingMs <= 0,
  };
}

function tokenLastUserActionAt(decodedToken = {}) {
  const explicit = Number(decodedToken?.lastUserActionAt);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const issuedAt = Number(decodedToken?.iat);
  if (Number.isFinite(issuedAt) && issuedAt > 0) return issuedAt * 1000;
  return Date.now();
}

function sessionIdleStateFromToken(token) {
  return jwtIdleState(decodeJWT(token));
}

module.exports = {
  IDLE_TIMEOUT_MS,
  USER_ACTION_REFRESH_THROTTLE_MS,
  USER_ACTION_REASONS,
  USER_ACTION_REASON_SET,
  isAllowedUserActionReason,
  issueUserSessionToken,
  jwtIdleState,
  sessionIdleStateFromToken,
  tokenLastUserActionAt,
};
