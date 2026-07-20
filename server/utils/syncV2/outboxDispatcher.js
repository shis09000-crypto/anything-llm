const { DataAccessCenter } = require("../dataAccess");
const { publishBroadcastEventDurably } = require("../broadcast");
const { syncV2Enabled } = require("./config");
const { hostname } = require("os");
const { randomUUID } = require("crypto");
const { metrics } = require("../observability/metrics");
const telemetry = require("@opentelemetry/api");
const { withCorrelation } = require("../observability/context");
const outboxTracer = telemetry.trace.getTracer("athena-sync-outbox");

const SyncV2 = DataAccessCenter.syncV2;
const DEFAULT_INTERVAL_MS = 250;
const PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_LANE_CONCURRENCY = 4;
const DEFAULT_MAX_ATTEMPTS = 8;
const WORKER_ID = `${hostname()}:${process.pid}:${randomUUID()}`;
let timer = null;
let activeFlush = null;
let lastPrunedAt = 0;
let lastMetricsAt = 0;
const counters = {
  flushes: 0,
  dispatched: 0,
  duplicates: 0,
  failures: 0,
  claimed: 0,
  retried: 0,
  deadLettered: 0,
  leaseLost: 0,
  released: 0,
};
const healthState = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastHealthAt: null,
  lastError: null,
  consecutiveFailures: 0,
  pending: 0,
  retrying: 0,
  deadLetters: 0,
  oldestPendingAgeMs: 0,
};

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function retryDelayMs(attemptCount = 0) {
  const base = positiveInteger(
    process.env.SYNC_V2_OUTBOX_RETRY_BASE_MS,
    500,
    60_000
  );
  const ceiling = positiveInteger(
    process.env.SYNC_V2_OUTBOX_RETRY_MAX_MS,
    5 * 60_000,
    60 * 60_000
  );
  const exponential = Math.min(
    base * 2 ** Math.min(Math.max(Number(attemptCount), 0), 12),
    ceiling
  );
  return Math.round(exponential * (0.8 + Math.random() * 0.4));
}

function dispatchFailure(error) {
  const code = String(error?.code || "sync_v2_dispatch_failed").slice(0, 160);
  const permanentCodes = new Set([
    "sync_node_unregistered",
    "sync_v2_invalid_outbox_event",
  ]);
  return {
    code,
    permanent: permanentCodes.has(code),
    detail: error?.message ? String(error.message).slice(0, 500) : null,
  };
}

function broadcastPayload(row, userId = null) {
  let payloadHint = {};
  let changedPaths = [];
  try {
    payloadHint = JSON.parse(row.payloadHintJson || "{}") || {};
  } catch {}
  try {
    changedPaths = JSON.parse(row.changedPathsJson || "[]") || [];
  } catch {}
  return {
    eventId: `${row.eventId}:${userId || "single"}`,
    namespace: "syncV2",
    type: "node.changed",
    eventPriority: "normal",
    visibility: userId ? "user" : row.visibility || "user",
    scope: {
      userId: userId || null,
      ...(row.ownerType === "workspace"
        ? { workspaceId: Number(row.ownerId) }
        : {}),
      ...(row.ownerType === "thread" ? { threadId: Number(row.ownerId) } : {}),
    },
    resource: { kind: "sync-node", id: row.nodeKey },
    version: Number(row.stateVersion),
    revision: Number(row.stateVersion),
    seq: Number(row.seq),
    nodeKey: row.nodeKey,
    stateVersion: Number(row.stateVersion),
    updatedAt: row.createdAt,
    origin: {
      clientId: row.originClientId || null,
      actionId: row.mutationId || null,
      requestId: row.requestId || null,
      traceId: row.traceId || null,
      traceparent: row.traceparent || null,
    },
    payload: {
      ...payloadHint,
      syncV2: {
        seq: Number(row.seq),
        eventId: row.eventId,
        nodeKey: row.nodeKey,
        stateVersion: Number(row.stateVersion),
        operation: row.eventType,
        changedPaths,
        originClientId: row.originClientId || null,
        mutationId: row.mutationId || null,
        updatedAt: row.createdAt?.toISOString?.() || row.createdAt,
        requestId: row.requestId || null,
        traceId: row.traceId || null,
        traceparent: row.traceparent || null,
      },
    },
    requiresAck: true,
  };
}

async function dispatchRow(row, leaseOwner = WORKER_ID) {
  const extracted = telemetry.propagation.extract(telemetry.context.active(), {
    traceparent: row.traceparent || undefined,
  });
  return await outboxTracer.startActiveSpan(
    "sync.outbox.dispatch",
    {
      kind: telemetry.SpanKind.PRODUCER,
      attributes: {
        "messaging.system": "athena-sync-v2-outbox",
        "messaging.message.id": row.eventId,
        "messaging.destination.name": row.nodeKey,
        "athena.sync.seq": Number(row.seq),
      },
    },
    extracted,
    async (span) => {
      try {
        return await withCorrelation(
          {
            requestId: row.requestId || null,
            traceId: span.spanContext().traceId || row.traceId || null,
            spanId: span.spanContext().spanId || null,
          },
          async () => {
            const userIds = await SyncV2.audienceUserIds(row);
            for (const userId of userIds) {
              const published = await publishBroadcastEventDurably(
                broadcastPayload(row, userId),
                { coalesce: false }
              );
              if (!published) {
                const error = new Error(
                  "sync_v2_broadcast_transport_unavailable"
                );
                error.code = "sync_v2_broadcast_transport_unavailable";
                throw error;
              }
            }
            await SyncV2.markOutboxDispatched({ seq: row.seq, leaseOwner });
            counters.dispatched += 1;
            metrics.syncOutboxEvents.inc({ action: "dispatched" });
          }
        );
      } catch (error) {
        span.recordException(error);
        span.setStatus({ code: telemetry.SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    }
  );
}

function partitionLanes(rows = []) {
  const lanes = new Map();
  for (const row of rows) {
    const key = String(row.nodeKey || `seq:${row.seq}`);
    if (!lanes.has(key)) lanes.set(key, []);
    lanes.get(key).push(row);
  }
  return [...lanes.values()].map((lane) =>
    lane.sort((left, right) => Number(left.seq) - Number(right.seq))
  );
}

async function runBounded(items, concurrency, worker) {
  let index = 0;
  const runners = Array.from(
    { length: Math.min(Math.max(concurrency, 1), items.length) },
    async () => {
      while (index < items.length) {
        const current = items[index++];
        await worker(current);
      }
    }
  );
  await Promise.all(runners);
}

async function processLane(lane, leaseOwner) {
  let dispatched = 0;
  for (let index = 0; index < lane.length; index += 1) {
    const row = lane[index];
    try {
      await dispatchRow(row, leaseOwner);
      dispatched += 1;
    } catch (error) {
      counters.failures += 1;
      if (error?.code === "sync_v2_outbox_lease_lost") counters.leaseLost += 1;
      const failure = dispatchFailure(error);
      const maxAttempts = positiveInteger(
        process.env.SYNC_V2_OUTBOX_MAX_ATTEMPTS,
        DEFAULT_MAX_ATTEMPTS,
        100
      );
      const result = await SyncV2.failOutboxClaim({
        seq: row.seq,
        leaseOwner,
        errorCode: failure.code,
        errorDetail: failure.detail,
        permanent: failure.permanent,
        maxAttempts,
        nextAttemptAt: new Date(
          Date.now() + retryDelayMs(Number(row.attemptCount || 0))
        ),
      });
      if (result.deadLettered) counters.deadLettered += 1;
      else if (result.updated) counters.retried += 1;
      if (result.deadLettered)
        metrics.syncOutboxEvents.inc({ action: "dead_lettered" });
      else if (result.updated)
        metrics.syncOutboxEvents.inc({ action: "retried" });
      const later = lane.slice(index + 1).map((candidate) => candidate.seq);
      if (later.length) {
        const released = await SyncV2.releaseOutboxClaims({
          seqs: later,
          leaseOwner,
        });
        counters.released += Number(released.count || 0);
      }
      console.warn("[SyncV2] outbox dispatch failed", {
        seq: row.seq,
        nodeKey: row.nodeKey,
        code: failure.code,
        attempt: Number(row.attemptCount || 0) + 1,
        deadLettered: result.deadLettered === true,
        requestId: row.requestId || null,
        traceId: row.traceId || null,
      });
      break;
    }
  }
  return dispatched;
}

async function flushSyncV2Outbox({ limit = 100, drain = false } = {}) {
  if (!syncV2Enabled()) return { skipped: true, reason: "disabled" };
  if (activeFlush) return activeFlush;
  healthState.lastAttemptAt = new Date().toISOString();
  activeFlush = (async () => {
    counters.flushes += 1;
    const now = Date.now();
    if (now - lastPrunedAt >= PRUNE_INTERVAL_MS) {
      await SyncV2.pruneExpired();
      lastPrunedAt = now;
    }
    const leaseMs = positiveInteger(
      process.env.SYNC_V2_OUTBOX_LEASE_MS,
      DEFAULT_LEASE_MS,
      5 * 60_000
    );
    const concurrency = positiveInteger(
      process.env.SYNC_V2_OUTBOX_LANE_CONCURRENCY,
      DEFAULT_LANE_CONCURRENCY,
      16
    );
    let dispatched = 0;
    let claimed = 0;
    let batches = 0;
    const maxBatches = drain ? 20 : 1;
    while (batches < maxBatches) {
      const rows = await SyncV2.claimOutbox({
        limit,
        leaseOwner: WORKER_ID,
        leaseMs,
      });
      if (!rows.length) break;
      batches += 1;
      claimed += rows.length;
      counters.claimed += rows.length;
      const laneResults = [];
      let heartbeatError = null;
      let activeHeartbeat = null;
      const heartbeat = setInterval(
        () => {
          if (activeHeartbeat) return;
          activeHeartbeat = SyncV2.renewOutboxClaims({
            seqs: rows.map((row) => row.seq),
            leaseOwner: WORKER_ID,
            leaseMs,
          })
            .catch((error) => {
              heartbeatError = error;
            })
            .finally(() => {
              activeHeartbeat = null;
            });
        },
        Math.max(Math.floor(leaseMs / 3), 1_000)
      );
      heartbeat.unref?.();
      try {
        await runBounded(partitionLanes(rows), concurrency, async (lane) => {
          laneResults.push(await processLane(lane, WORKER_ID));
        });
        if (activeHeartbeat) await activeHeartbeat;
        if (heartbeatError) throw heartbeatError;
      } finally {
        clearInterval(heartbeat);
      }
      dispatched += laneResults.reduce((sum, count) => sum + count, 0);
      if (!drain || rows.length < Number(limit)) break;
    }
    if (now - lastMetricsAt >= 5_000) {
      const health = await SyncV2.outboxHealth();
      healthState.lastHealthAt = new Date().toISOString();
      healthState.pending = Number(health.pending || 0);
      healthState.retrying = Number(health.retrying || 0);
      healthState.deadLetters = Number(health.deadLetters || 0);
      healthState.oldestPendingAgeMs = Math.max(
        Number(health.oldestPendingAgeMs || 0),
        0
      );
      metrics.syncOutboxPending.set(Number(health.pending || 0));
      metrics.syncOutboxRetrying.set(Number(health.retrying || 0));
      metrics.syncOutboxDeadLetters.set(Number(health.deadLetters || 0));
      metrics.syncOutboxOldestAge.set(
        Math.max(Number(health.oldestPendingAgeMs || 0), 0) / 1000
      );
      lastMetricsAt = now;
    }
    return { dispatched, claimed, batches };
  })()
    .then((result) => {
      healthState.lastSuccessAt = new Date().toISOString();
      healthState.lastError = null;
      healthState.consecutiveFailures = 0;
      return result;
    })
    .catch((error) => {
      healthState.lastError =
        error?.code || error?.message || "outbox_flush_failed";
      healthState.consecutiveFailures += 1;
      throw error;
    })
    .finally(() => {
      activeFlush = null;
    });
  return activeFlush;
}

async function startSyncV2OutboxDispatcher({
  intervalMs = DEFAULT_INTERVAL_MS,
} = {}) {
  if (!syncV2Enabled() || timer) return false;
  await flushSyncV2Outbox();
  timer = setInterval(
    () => {
      void flushSyncV2Outbox().catch((error) =>
        console.error("[SyncV2] outbox flush failed", {
          code: error?.code || "outbox_flush_failed",
        })
      );
    },
    Math.max(Number(intervalMs) || DEFAULT_INTERVAL_MS, 50)
  );
  timer.unref?.();
  return true;
}

async function stopSyncV2OutboxDispatcher({ drain = true } = {}) {
  if (timer) clearInterval(timer);
  timer = null;
  if (activeFlush) await activeFlush.catch(() => null);
  if (drain) await flushSyncV2Outbox({ drain: true });
}

function syncV2OutboxSnapshot() {
  const unhealthyAgeMs = positiveInteger(
    process.env.SYNC_V2_OUTBOX_DEGRADED_AGE_MS,
    5 * 60_000,
    24 * 60 * 60_000
  );
  return {
    running: Boolean(timer),
    workerId: WORKER_ID,
    healthy: healthState.consecutiveFailures < 3,
    degraded:
      healthState.deadLetters > 0 ||
      healthState.oldestPendingAgeMs >= unhealthyAgeMs,
    degradedAgeThresholdMs: unhealthyAgeMs,
    ...healthState,
    counters: { ...counters },
  };
}

module.exports = {
  flushSyncV2Outbox,
  startSyncV2OutboxDispatcher,
  stopSyncV2OutboxDispatcher,
  syncV2OutboxSnapshot,
  _internals: {
    broadcastPayload,
    counters,
    dispatchRow,
    dispatchFailure,
    partitionLanes,
    processLane,
    retryDelayMs,
    runBounded,
  },
};
