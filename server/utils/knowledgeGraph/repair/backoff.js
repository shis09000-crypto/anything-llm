const BACKOFF_STEPS_MS = [
  5 * 60 * 1_000,
  15 * 60 * 1_000,
  60 * 60 * 1_000,
  6 * 60 * 60 * 1_000,
  24 * 60 * 60 * 1_000,
];

const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1_000;

function nextRetryAt(retryCount = 0) {
  const index = Math.min(
    Math.max(Number(retryCount || 0), 0),
    BACKOFF_STEPS_MS.length - 1
  );
  const jitter = Math.floor(Math.random() * 45_000);
  return new Date(Date.now() + BACKOFF_STEPS_MS[index] + jitter);
}

function cooldownUntil(ms = DEFAULT_COOLDOWN_MS) {
  return new Date(Date.now() + Number(ms || DEFAULT_COOLDOWN_MS));
}

function isPermanentRepairError(error = null) {
  const message = String(error?.message || error || "").toLowerCase();
  return [
    "source_document_missing",
    "graph_chunk_text_not_found",
    "missing_source_text",
    "invalid_document",
    "unrecoverable",
  ].some((token) => message.includes(token));
}

module.exports = {
  BACKOFF_STEPS_MS,
  DEFAULT_COOLDOWN_MS,
  nextRetryAt,
  cooldownUntil,
  isPermanentRepairError,
};
