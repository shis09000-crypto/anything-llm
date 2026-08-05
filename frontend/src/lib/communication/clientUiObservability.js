import { postJson } from "./apiClient";

const ALLOWED_EVENTS = new Set([
  "overview_preempted",
  "overview_recovered",
  "overview_failed",
  "auth_reconnecting",
  "auth_recovered",
  "auth_terminal",
  "passkey_local_ready",
  "passkey_cross_device_only",
  "passkey_unavailable",
  "document_loaded",
  "react_root_mounted",
  "broadcast_connection_closed",
  "broadcast_incremental_replay",
  "broadcast_full_reconcile",
]);
const ALLOWED_SURFACES = new Set([
  "workspace_overview",
  "auth_lifecycle",
  "passkey_capability",
  "application_shell",
  "realtime_sync",
]);
const ALLOWED_OUTCOMES = new Set(["observed", "recovered", "failed"]);
const ALLOWED_REASONS = new Set([
  "scheduler_abort",
  "http_error",
  "network_error",
  "identity_unavailable",
  "session_expired",
  "session_idle_expired",
  "session_revoked",
  "session_epoch_incompatible",
  "account_disabled",
  "account_suspended",
  "client_revoked",
  "device_identity_reauth",
  "force_reauth",
  "insecure_context",
  "rp_id_invalid",
  "server_passkey_disabled",
  "webauthn_unavailable",
  "embedded_webview_unsupported",
  "platform_authenticator_unavailable",
  "no_available_authenticator",
  "webauthn_security_error",
  "none",
  "pong_timeout",
  "connection_closed",
  "cursor_replay",
  "sync_required",
  "unknown",
]);
const OBSERVATION_DEDUPE_PREFIX = "athena.client-observation:";

function shouldRecordOnce(key) {
  if (!key || typeof window === "undefined") return true;
  try {
    const storageKey = `${OBSERVATION_DEDUPE_PREFIX}${key}`;
    if (window.sessionStorage.getItem(storageKey)) return false;
    window.sessionStorage.setItem(storageKey, String(Date.now()));
  } catch {}
  return true;
}

function platform() {
  return window.matchMedia?.("(max-width: 768px)")?.matches
    ? "mobile_web"
    : "desktop_web";
}

function visibility() {
  return document.hidden ? "hidden" : "visible";
}

export function recordClientUiObservation(observation = {}) {
  if (typeof window === "undefined") return;
  const event = ALLOWED_EVENTS.has(observation.event)
    ? observation.event
    : null;
  if (!event) return;
  const surface = ALLOWED_SURFACES.has(observation.surface)
    ? observation.surface
    : "workspace_overview";
  if (!shouldRecordOnce(observation.onceKey)) return;

  const payload = {
    event,
    surface,
    platform: platform(),
    visibility: visibility(),
    outcome: ALLOWED_OUTCOMES.has(observation.outcome)
      ? observation.outcome
      : "observed",
    reason: ALLOWED_REASONS.has(observation.reason)
      ? observation.reason
      : "unknown",
    requestId: String(observation.requestId || "").slice(0, 160),
    durationMs: Math.max(
      0,
      Math.min(Number(observation.durationMs) || 0, 60_000)
    ),
    retryCount: Math.max(
      0,
      Math.min(Math.trunc(Number(observation.retryCount) || 0), 20)
    ),
  };

  void postJson("/operations/client-ui-observations", payload, {
    communicationScene: "client-ui-observability",
    task: false,
    timeoutMs: 5_000,
  }).catch(() => {
    // Client observability is best-effort and must never affect navigation.
  });
}
