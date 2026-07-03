const DEFAULT_AUTO_POLL_TIMEOUT_MS = 45_000;
const DEFAULT_FOREGROUND_POLL_TIMEOUT_MS = 120_000;

function envNumber(name, fallback) {
  const value =
    typeof import.meta !== "undefined" ? import.meta.env?.[name] : undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function readerPostprocessLockKey({
  workspaceSlug = null,
  readerDocumentId = null,
} = {}) {
  return `${workspaceSlug || "global"}:${readerDocumentId || "unknown"}`;
}

export function readerPostprocessIsForeground(intent = "maintenance") {
  return intent === "manual" || intent === "open";
}

export function readerPostprocessPollTimeoutMs({
  foreground = false,
  serverTimeoutMs = null,
} = {}) {
  if (foreground) return DEFAULT_FOREGROUND_POLL_TIMEOUT_MS;
  const serverTimeout = Number(serverTimeoutMs);
  if (Number.isFinite(serverTimeout) && serverTimeout > 0) return serverTimeout;
  return envNumber(
    "VITE_READER_POSTPROCESS_AUTO_POLL_TIMEOUT_MS",
    DEFAULT_AUTO_POLL_TIMEOUT_MS
  );
}

export function nextReaderPostprocessDelay(
  currentDelayMs = 1_200,
  { foreground = false, hidden = false, random = Math.random } = {}
) {
  const base = Math.max(500, Number(currentDelayMs) || 1_200);
  const growth = foreground ? 1.35 : hidden ? 1.8 : 1.5;
  const cap = foreground ? 2_500 : hidden ? 12_000 : 6_000;
  const jitter = 0.9 + Math.max(0, Math.min(1, random())) * 0.2;
  return Math.min(cap, Math.floor(base * growth * jitter));
}

export function readerPostprocessScheduleOptions({
  intent = "maintenance",
  workspaceSlug = null,
  readerDocumentId = null,
} = {}) {
  const foreground = readerPostprocessIsForeground(intent);
  const lockKey = readerPostprocessLockKey({ workspaceSlug, readerDocumentId });
  return {
    foreground,
    lockKey,
    priority: foreground ? "P1" : "P4",
    policy: foreground ? "visible" : "maintenance",
    resource: foreground ? "network" : "idle",
    emergency: false,
    intentRank: foreground ? 10 : 90,
    label:
      intent === "manual"
        ? "reader:manual-postprocess"
        : "reader:postprocess-poll",
    dedupeKey: `reader:postprocess:${lockKey}`,
  };
}
