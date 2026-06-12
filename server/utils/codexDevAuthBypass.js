const CODEX_DEV_AUTH_BYPASS_HEADER = "x-codex-dev-auth-bypass";
const CODEX_DEV_AUTH_BYPASS_QUERY = "codexAuthBypass";
const CODEX_DEV_AUTH_BYPASS_KEY = process.env.CODEX_DEV_AUTH_BYPASS_KEY || "";
const CODEX_DEV_AUTH_BYPASS_USER_ID = Number(
  process.env.CODEX_DEV_AUTH_BYPASS_USER_ID || 1
);

function isCodexDevAuthBypassEnabled(request) {
  if (process.env.NODE_ENV === "production") return false;
  if (!CODEX_DEV_AUTH_BYPASS_KEY) return false;
  const headerValue =
    request.header?.(CODEX_DEV_AUTH_BYPASS_HEADER) ||
    request.headers?.[CODEX_DEV_AUTH_BYPASS_HEADER];
  const queryValue = request.query?.[CODEX_DEV_AUTH_BYPASS_QUERY];
  return (
    headerValue === CODEX_DEV_AUTH_BYPASS_KEY ||
    queryValue === CODEX_DEV_AUTH_BYPASS_KEY
  );
}

function codexDevAuthUser() {
  return {
    id:
      Number.isFinite(CODEX_DEV_AUTH_BYPASS_USER_ID) &&
      CODEX_DEV_AUTH_BYPASS_USER_ID > 0
        ? CODEX_DEV_AUTH_BYPASS_USER_ID
        : 1,
    username: "codex-dev",
    role: "admin",
    suspended: false,
    __codexDevAuthBypass: true,
  };
}

function applyCodexDevAuthBypass(request, response) {
  if (!isCodexDevAuthBypassEnabled(request)) return false;
  response.locals.codexDevAuthBypass = true;
  response.locals.multiUserMode = false;
  response.locals.user = codexDevAuthUser();
  return true;
}

module.exports = {
  CODEX_DEV_AUTH_BYPASS_HEADER,
  CODEX_DEV_AUTH_BYPASS_QUERY,
  CODEX_DEV_AUTH_BYPASS_KEY,
  CODEX_DEV_AUTH_BYPASS_USER_ID,
  applyCodexDevAuthBypass,
  codexDevAuthUser,
  isCodexDevAuthBypassEnabled,
};
