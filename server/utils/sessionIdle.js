const { makeJWT, decodeJWT } = require("./http");
const { normalizeAllowedEnvs, normalizeRole } = require("./authz/accountRoles");
const crypto = require("crypto");
const { lazyDataAccessFacade } = require("./dataAccess/lazyFacade");
const AdminSystem = lazyDataAccessFacade("adminSystem");

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

function normalizeSessionClientId(value = null) {
  if (value === null || value === undefined) return null;
  const next = String(value).trim();
  if (!next || next === "legacy") return null;
  return next.slice(0, 256);
}

function normalizeSessionId(value = null) {
  if (value === null || value === undefined) return null;
  const next = String(value).trim();
  return next ? next.slice(0, 128) : null;
}

function newSessionId() {
  return `sess_${crypto.randomUUID?.() || crypto.randomBytes(16).toString("hex")}`;
}

function sessionTokenOptionsFromClientContext(context = {}, currentToken = {}) {
  const clientId = normalizeSessionClientId(context?.clientId);
  if (!clientId || context?.legacy) return {};
  return {
    clientId,
    sessionId: normalizeSessionId(currentToken?.sessionId) || newSessionId(),
  };
}

function sessionClientIdFromToken(decodedToken = {}) {
  return normalizeSessionClientId(decodedToken?.clientId);
}

function issueUserSessionToken(
  user,
  lastUserActionAtOrOptions = Date.now(),
  maybeOptions = {}
) {
  const options =
    typeof lastUserActionAtOrOptions === "object" &&
    lastUserActionAtOrOptions !== null
      ? lastUserActionAtOrOptions
      : maybeOptions;
  const lastUserActionAt =
    typeof lastUserActionAtOrOptions === "object"
      ? Number(lastUserActionAtOrOptions.lastUserActionAt) || Date.now()
      : Number(lastUserActionAtOrOptions) || Date.now();
  const clientId = normalizeSessionClientId(options.clientId);
  const sessionId = normalizeSessionId(options.sessionId);
  return makeJWT(
    {
      id: user.id,
      userId: user.id,
      authUserId: user.authUserId || null,
      username: user.username,
      role: normalizeRole(user.role),
      allowedEnvs: normalizeAllowedEnvs(user.allowedEnvs, user.role),
      lastUserActionAt: Number(lastUserActionAt),
      ...(clientId ? { clientId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(sessionId && options.persistedSession
        ? {
            sid: sessionId,
            jti: options.jti || crypto.randomUUID(),
            tokenVersion: Number(options.tokenVersion) || 1,
            authMode: options.authMode || "password",
          }
        : {}),
    },
    process.env.JWT_EXPIRY
  );
}

async function createUserSessionToken(user, options = {}) {
  const AuthSession = AdminSystem.authSession;
  if (!AuthSession.enabled()) return issueUserSessionToken(user, options);
  const session = await AuthSession.create({
    subjectType: "user",
    authUserId: user.authUserId,
    clientId: normalizeSessionClientId(options.clientId),
    authMode: options.authMode || "password",
    tokenVersion: 1,
  });
  return issueUserSessionToken(user, {
    ...options,
    sessionId: session.sessionId,
    tokenVersion: session.tokenVersion,
    authMode: session.authMode,
    persistedSession: true,
  });
}

async function createSingleUserSessionToken(options = {}) {
  const AuthSession = AdminSystem.authSession;
  const session = AuthSession.enabled()
    ? await AuthSession.create({
        subjectType: "instance",
        clientId: normalizeSessionClientId(options.clientId),
        authMode: options.authMode || "password",
        tokenVersion: 1,
      })
    : {
        sessionId: newSessionId(),
        clientId: normalizeSessionClientId(options.clientId),
        authMode: options.authMode || "password",
        tokenVersion: 1,
      };
  return makeJWT(
    {
      subjectType: "instance",
      authMode: session.authMode,
      authVersion: AuthSession.singleUserAuthVersion(),
      clientId: session.clientId,
      sessionId: session.sessionId,
      sid: session.sessionId,
      jti: crypto.randomUUID(),
      tokenVersion: session.tokenVersion,
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
  createSingleUserSessionToken,
  createUserSessionToken,
  issueUserSessionToken,
  jwtIdleState,
  sessionClientIdFromToken,
  sessionTokenOptionsFromClientContext,
  sessionIdleStateFromToken,
  tokenLastUserActionAt,
};
