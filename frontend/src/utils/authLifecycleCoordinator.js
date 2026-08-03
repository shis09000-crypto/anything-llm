import { clearSensitiveClientSession } from "@/utils/security/clearSensitiveClientState";

const RETURN_REF_KEY = "athena.auth.return-ref.v1";
const REDIRECT_GUARD_KEY = "athena.auth.redirect-guard.v1";
const HARD_RELOAD_PREFIX = "athena.auth.hard-reload:";
const RETURN_TTL_MS = 15 * 60 * 1000;
const REDIRECT_GUARD_MS = 10_000;

export const TERMINAL_AUTH_REASONS = new Set([
  "session_expired",
  "session_absolute_expired",
  "session_idle_expired",
  "session_revoked",
  "session_epoch_incompatible",
  "account_disabled",
  "account_suspended",
  "account_unavailable",
  "client_revoked",
  "device_identity_reauth",
  "force_reauth",
  "missing_session_storage",
  "invalid_auth_token",
  "invalid_auth_credentials",
]);

export function authReasonFrom(source = {}, fallback = "") {
  const raw = source?.raw && typeof source.raw === "object" ? source.raw : {};
  return String(
    source?.reasonCode ||
      source?.reason ||
      raw?.reasonCode ||
      raw?.reason ||
      raw?.code ||
      raw?.error ||
      source?.code ||
      fallback
  )
    .trim()
    .toLowerCase();
}

export function isTerminalAuthReason(source = {}) {
  return TERMINAL_AUTH_REASONS.has(
    typeof source === "string" ? source.toLowerCase() : authReasonFrom(source)
  );
}

function safeRelativeTarget(candidate) {
  if (typeof window === "undefined") return null;
  try {
    const target = new URL(
      candidate || window.location.href,
      window.location.origin
    );
    if (target.origin !== window.location.origin) return null;
    if (!target.pathname.startsWith("/") || target.pathname.startsWith("//"))
      return null;
    if (["/login", "/onboarding"].includes(target.pathname)) return null;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return null;
  }
}

export function preserveAuthReturnRef(candidate = null) {
  if (typeof window === "undefined") return null;
  const target = safeRelativeTarget(candidate);
  if (!target) return null;
  try {
    window.sessionStorage.setItem(
      RETURN_REF_KEY,
      JSON.stringify({ target, savedAt: Date.now() })
    );
  } catch {}
  return target;
}

export function consumeAuthReturnRef() {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(RETURN_REF_KEY));
    window.sessionStorage.removeItem(RETURN_REF_KEY);
    if (!parsed?.savedAt || Date.now() - parsed.savedAt > RETURN_TTL_MS)
      return null;
    return safeRelativeTarget(parsed.target);
  } catch {
    try {
      window.sessionStorage.removeItem(RETURN_REF_KEY);
    } catch {}
    return null;
  }
}

export function redirectToLogin({ reason = "session_revoked" } = {}) {
  if (typeof window === "undefined") return false;
  if (window.location.pathname === "/login") return false;
  const normalizedReason = authReasonFrom({ reason }, "session_revoked");
  if (!isTerminalAuthReason(normalizedReason)) return false;

  try {
    const previous = JSON.parse(
      window.sessionStorage.getItem(REDIRECT_GUARD_KEY) || "null"
    );
    if (
      previous?.reason === normalizedReason &&
      Date.now() - Number(previous.at || 0) < REDIRECT_GUARD_MS
    )
      return false;
    window.sessionStorage.setItem(
      REDIRECT_GUARD_KEY,
      JSON.stringify({ reason: normalizedReason, at: Date.now() })
    );
  } catch {}

  preserveAuthReturnRef();
  clearSensitiveClientSession({
    includeDurableCaches: false,
    preserveRecovery: true,
  });
  window.location.replace(
    `/login?nt=1&reason=${encodeURIComponent(normalizedReason)}&returnRef=1`
  );
  return true;
}

export function hardReloadForRelease(releaseId) {
  if (typeof window === "undefined") return false;
  const id = String(releaseId || "unknown").slice(0, 128);
  const key = `${HARD_RELOAD_PREFIX}${id}`;
  try {
    if (window.sessionStorage.getItem(key)) return false;
    window.sessionStorage.setItem(key, String(Date.now()));
  } catch {}
  const target = new URL(window.location.href);
  target.searchParams.set("athenaRelease", id);
  window.location.replace(target.toString());
  return true;
}
