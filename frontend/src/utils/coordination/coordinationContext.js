const CENTERS = new Set(["task", "data", "cache", "recovery", "optimistic"]);
const PRIORITIES = new Set(["P0", "P1", "P2", "P3", "P4"]);

function safeId(value, fallback = null) {
  const normalized = String(value || "").trim();
  if (!normalized) return fallback;
  return /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,191}$/.test(normalized)
    ? normalized
    : fallback;
}

function randomId(prefix) {
  const value =
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${value}`;
}

export function createCoordinationContext(input = {}) {
  const center = CENTERS.has(input.center) ? input.center : "task";
  const priority = PRIORITIES.has(input.priority) ? input.priority : "P2";
  const timeoutMs = Math.max(
    1_000,
    Math.min(Number(input.timeoutMs) || 30_000, 24 * 60 * 60 * 1_000)
  );
  return Object.freeze({
    coordinationRunId:
      safeId(input.coordinationRunId) || randomId("coordination"),
    stepId: safeId(input.stepId) || randomId("step"),
    center,
    correlationId: safeId(input.correlationId) || randomId("correlation"),
    causationId: safeId(input.causationId),
    deadlineAt:
      Number.isFinite(Date.parse(input.deadlineAt)) &&
      Date.parse(input.deadlineAt) > Date.now()
        ? new Date(input.deadlineAt).toISOString()
        : new Date(Date.now() + timeoutMs).toISOString(),
    priority,
    idempotencyKey: safeId(input.idempotencyKey),
  });
}

export function normalizeCoordinationContext(value = null) {
  if (!value || typeof value !== "object") return null;
  if (!CENTERS.has(value.center) || !PRIORITIES.has(value.priority))
    return null;
  if (!safeId(value.coordinationRunId) || !safeId(value.stepId)) return null;
  if (!safeId(value.correlationId)) return null;
  if (
    !Number.isFinite(Date.parse(value.deadlineAt)) ||
    Date.parse(value.deadlineAt) <= Date.now()
  )
    return null;
  return createCoordinationContext(value);
}
