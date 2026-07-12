import { recordCommunicationEvent } from "@/lib/communication/communicationMetrics";

export const GLOBAL_REFRESH_ALLOWED_REASONS = new Set([
  "open-crypto",
  "close-crypto",
  "open-settings",
  "close-settings",
  "open-account",
  "close-account",
]);

export function globalRefreshReason(detail = {}) {
  return String(
    detail.reason ||
      detail.navigationReason ||
      detail.lifecycleReason ||
      detail.source ||
      ""
  ).trim();
}

export function isGlobalRefreshAllowed(detail = {}) {
  return GLOBAL_REFRESH_ALLOWED_REASONS.has(globalRefreshReason(detail));
}

export function guardGlobalRefresh({
  detail = {},
  path = "global-refresh",
  source = "global-refresh",
} = {}) {
  const reason = globalRefreshReason(detail);
  const allowed = isGlobalRefreshAllowed(detail);
  recordCommunicationEvent({
    type: allowed ? "global_refresh_allowed" : "global_refresh_blocked",
    method: "EVENT",
    path,
    communicationScene: "navigation",
    durationMs: 0,
    requestBytes: 0,
    responseBytes: 0,
    ok: allowed,
    reason: reason || "missing-reason",
    source: detail.source || source,
    eventId: detail.eventId || null,
  });
  return {
    allowed,
    reason,
    detail: {
      ...detail,
      globalRefreshAllowed: allowed,
      globalRefreshReason: reason || null,
    },
  };
}
