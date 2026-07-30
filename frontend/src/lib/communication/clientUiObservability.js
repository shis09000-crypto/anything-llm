import { postJson } from "./apiClient";

const ALLOWED_EVENTS = new Set([
  "overview_preempted",
  "overview_recovered",
  "overview_failed",
]);
const ALLOWED_OUTCOMES = new Set(["observed", "recovered", "failed"]);
const ALLOWED_REASONS = new Set([
  "scheduler_abort",
  "http_error",
  "network_error",
  "unknown",
]);

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

  const payload = {
    event,
    surface: "workspace_overview",
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
