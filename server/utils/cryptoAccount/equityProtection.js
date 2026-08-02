const crypto = require("crypto");
const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const { emitSemanticEvent } = require("../observability/semanticEvents");
const { metrics } = require("../observability/metrics");
const {
  equityBreakdownFromTotalBalance,
  selectEquityUsd,
  todayWindow,
} = require("../cryptoGate/equityHistory");
const { safeErrorMessage } = require("../cryptoGate/sanitizer");

const CryptoData = lazyDataAccessFacade("crypto");
const SAMPLE_INTERVAL_MS = 1_500;
const PERSIST_INTERVAL_MS = 60_000;
const MAX_RETRY_MS = 30_000;
const EQUITY_MODE = "api_total";
const TASK_DESCRIPTOR = Object.freeze({
  priority: "P2",
  policy: "background_continuation",
  protected: true,
  preemptible: false,
  semantics: "athena-task-priority-v1",
});

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundEquity(value) {
  const number = finiteNumber(value);
  return number === null ? null : Number(number.toFixed(8));
}

function valueFingerprint(breakdown) {
  return [
    breakdown.apiTotalUsd,
    breakdown.unrealizedPnlUsd,
    breakdown.netEquityUsd,
    breakdown.accountSumUsd,
  ]
    .map((value) => Number(value || 0).toFixed(8))
    .join(":");
}

function shanghaiParts(ts) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .formatToParts(new Date(ts))
      .map((part) => [part.type, part.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

function normalizeStoredPoint(row) {
  if (!row) return null;
  const ts = new Date(row.sampledAt).getTime();
  const equityUsd = roundEquity(row.apiTotalUsd);
  if (!Number.isFinite(ts) || equityUsd === null) return null;
  let accountAmounts = {};
  try {
    const parsed = JSON.parse(row.breakdownJson || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      accountAmounts = parsed;
  } catch {
    // A damaged historical checkpoint must not stop the protected recorder.
  }
  return {
    ts,
    equityUsd,
    source: row.source || "protected_checkpoint",
    equityMode: EQUITY_MODE,
    persisted: true,
    equityBreakdown: {
      apiTotalUsd: equityUsd,
      unrealizedPnlUsd: roundEquity(row.unrealizedPnlUsd) || 0,
      netEquityUsd: roundEquity(row.netEquityUsd) || equityUsd,
      accountSumUsd: roundEquity(row.accountSumUsd) || 0,
      accountAmounts,
    },
  };
}

class AccountEquityHistoryStore {
  async loadWindow(connectionId, windowStartAt, windowEndAt) {
    return (
      await CryptoData.listAccountEquitySnapshots({
        where: {
          connectionId: String(connectionId),
          sampledAt: {
            gte: new Date(windowStartAt),
            lte: new Date(windowEndAt),
          },
        },
        orderBy: { sampledAt: "asc" },
        take: 2_000,
      })
    )
      .map(normalizeStoredPoint)
      .filter(Boolean);
  }

  async persist({ connection, point }) {
    const sampleBucket = Math.floor(point.ts / PERSIST_INTERVAL_MS);
    const breakdown = point.equityBreakdown || {};
    const id = `crypto_equity_${crypto
      .createHash("sha256")
      .update(`${connection.id}:${sampleBucket}`)
      .digest("hex")
      .slice(0, 32)}`;
    return CryptoData.upsertAccountEquitySnapshot({
      where: {
        connectionId_sampleBucket: {
          connectionId: String(connection.id),
          sampleBucket,
        },
      },
      create: {
        id,
        connectionId: String(connection.id),
        userId: Number(connection.userId),
        authUserId: Number(connection.authUserId),
        sampleBucket,
        sampledAt: new Date(point.ts),
        apiTotalUsd: Number(breakdown.apiTotalUsd || point.equityUsd).toFixed(
          8
        ),
        unrealizedPnlUsd: Number(breakdown.unrealizedPnlUsd || 0).toFixed(8),
        netEquityUsd: Number(breakdown.netEquityUsd || point.equityUsd).toFixed(
          8
        ),
        accountSumUsd: Number(breakdown.accountSumUsd || 0).toFixed(8),
        breakdownJson: JSON.stringify(breakdown.accountAmounts || {}),
        source: point.source || "protected_sampler",
        quality: "observed",
      },
      update: {
        sampledAt: new Date(point.ts),
        apiTotalUsd: Number(breakdown.apiTotalUsd || point.equityUsd).toFixed(
          8
        ),
        unrealizedPnlUsd: Number(breakdown.unrealizedPnlUsd || 0).toFixed(8),
        netEquityUsd: Number(breakdown.netEquityUsd || point.equityUsd).toFixed(
          8
        ),
        accountSumUsd: Number(breakdown.accountSumUsd || 0).toFixed(8),
        breakdownJson: JSON.stringify(breakdown.accountAmounts || {}),
        source: point.source || "protected_sampler",
        quality: "observed",
      },
    });
  }
}

class AccountEquityProtectionService {
  constructor({
    connection,
    restClientFactory,
    store = new AccountEquityHistoryStore(),
    now = () => Date.now(),
    sampleIntervalMs = SAMPLE_INTERVAL_MS,
    persistIntervalMs = PERSIST_INTERVAL_MS,
  }) {
    this.connection = connection;
    this.restClientFactory = restClientFactory;
    this.store = store;
    this.now = now;
    this.sampleIntervalMs = Math.max(250, Number(sampleIntervalMs) || 0);
    this.persistIntervalMs = Math.max(
      this.sampleIntervalMs,
      Number(persistIntervalMs) || 0
    );
    this.points = [];
    this.loadedWindowStartAt = null;
    this.timer = null;
    this.inFlight = null;
    this.running = false;
    this.lastSampleAt = null;
    this.lastSuccessAt = null;
    this.lastChangeAt = null;
    this.lastPersistAt = null;
    this.lastFingerprint = null;
    this.lastPersistedFingerprint = null;
    this.dirtySincePersist = false;
    this.lastError = null;
    this.consecutiveFailures = 0;
    this.historyVersion = 0;
  }

  async loadWindow() {
    const window = todayWindow(this.now());
    if (this.loadedWindowStartAt === window.windowStartAt) return;
    this.points = await this.store.loadWindow(
      this.connection.id,
      window.windowStartAt,
      window.windowEndAt
    );
    const latest = this.points.at(-1) || null;
    this.lastFingerprint = latest
      ? valueFingerprint(latest.equityBreakdown)
      : null;
    this.lastPersistedFingerprint = this.lastFingerprint;
    this.lastPersistAt = latest?.ts || null;
    this.dirtySincePersist = false;
    this.loadedWindowStartAt = window.windowStartAt;
    if (this.points.length) this.historyVersion += 1;
  }

  appendChangedPoint(point) {
    const window = todayWindow(point.ts);
    if (this.loadedWindowStartAt !== window.windowStartAt) {
      this.points = [];
      this.loadedWindowStartAt = window.windowStartAt;
    }
    this.points.push(point);
    if (this.points.length > 60_000) this.points.splice(0, 5_000);
    this.lastChangeAt = point.ts;
    this.dirtySincePersist = true;
    this.historyVersion += 1;
  }

  shouldPersist(point, fingerprint, force = false) {
    if (!point || !this.dirtySincePersist) return false;
    if (force || !this.lastPersistAt) return true;
    return point.ts - this.lastPersistAt >= this.persistIntervalMs;
  }

  async persistLatest({ force = false } = {}) {
    const point = this.points.at(-1);
    if (!point) return false;
    const fingerprint = valueFingerprint(point.equityBreakdown);
    if (!this.shouldPersist(point, fingerprint, force)) return false;
    await this.store.persist({ connection: this.connection, point });
    this.lastPersistAt = point.ts;
    this.lastPersistedFingerprint = fingerprint;
    this.dirtySincePersist = false;
    metrics.cryptoAccountEquitySamples.inc({ outcome: "persisted" });
    return true;
  }

  emitTransition(eventType, outcome, severity = "info") {
    emitSemanticEvent({
      eventType,
      category: "crypto-account-equity",
      severity,
      outcome,
      subject: {
        type: "component",
        component: "crypto-account-access",
        operation: "protected-equity-sampling",
      },
      metadata: {
        sampleIntervalMs: this.sampleIntervalMs,
        taskPriority: TASK_DESCRIPTOR.priority,
        protected: true,
      },
      sensitivity: "metadata_only",
    });
  }

  async sample(source = "protected_sampler") {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      const sampledAt = this.now();
      this.lastSampleAt = sampledAt;
      try {
        await this.loadWindow();
        const result = await this.restClientFactory().getTotalBalanceRaw();
        if (!result?.success)
          throw new Error(
            result?.safeErrorMessage || "Gate total balance request failed."
          );
        const breakdown = equityBreakdownFromTotalBalance(result.data);
        const equityUsd = roundEquity(selectEquityUsd(breakdown, EQUITY_MODE));
        if (equityUsd === null)
          throw new Error("Gate total equity amount was not found.");
        const fingerprint = valueFingerprint(breakdown);
        const changed = fingerprint !== this.lastFingerprint;
        const recovered = this.consecutiveFailures > 0;
        this.lastSuccessAt = sampledAt;
        this.lastError = null;
        this.consecutiveFailures = 0;
        if (changed) {
          this.appendChangedPoint({
            ts: sampledAt,
            equityUsd,
            equityBreakdown: breakdown,
            source,
            equityMode: EQUITY_MODE,
            persisted: false,
          });
          this.lastFingerprint = fingerprint;
          metrics.cryptoAccountEquitySamples.inc({ outcome: "changed" });
          await this.persistLatest();
        } else {
          metrics.cryptoAccountEquitySamples.inc({ outcome: "unchanged" });
        }
        if (recovered) {
          metrics.cryptoAccountEquitySamples.inc({ outcome: "recovered" });
          this.emitTransition(
            "crypto.account.equity_recording.recovered",
            "recovered"
          );
        }
        return { changed, point: changed ? this.points.at(-1) : null };
      } catch (error) {
        const wasHealthy = this.consecutiveFailures === 0;
        this.consecutiveFailures += 1;
        this.lastError = safeErrorMessage(error);
        metrics.cryptoAccountEquitySamples.inc({ outcome: "failed" });
        if (wasHealthy)
          this.emitTransition(
            "crypto.account.equity_recording.degraded",
            "failed",
            "warning"
          );
        throw error;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  nextDelay(elapsedMs = 0) {
    if (!this.consecutiveFailures)
      return Math.max(0, this.sampleIntervalMs - elapsedMs);
    return Math.min(
      MAX_RETRY_MS,
      this.sampleIntervalMs * 2 ** Math.min(this.consecutiveFailures - 1, 5)
    );
  }

  schedule() {
    if (!this.running || this.timer) return;
    const startedAt = this.now();
    this.sample()
      .catch(() => {})
      .finally(() => {
        if (!this.running) return;
        const delay = this.nextDelay(this.now() - startedAt);
        this.timer = setTimeout(() => {
          this.timer = null;
          this.schedule();
        }, delay);
        this.timer.unref?.();
      });
  }

  async start() {
    if (this.running) return this.status();
    this.running = true;
    await this.loadWindow();
    this.emitTransition("crypto.account.equity_recording.started", "started");
    this.schedule();
    return this.status();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight?.catch?.(() => {});
    await this.persistLatest({ force: true }).catch(() => {});
    return this.status();
  }

  status() {
    const now = this.now();
    const sampleAgeMs = this.lastSuccessAt
      ? Math.max(0, now - this.lastSuccessAt)
      : null;
    return {
      running: this.running,
      protected: true,
      task: TASK_DESCRIPTOR,
      sampleIntervalMs: this.sampleIntervalMs,
      persistIntervalMs: this.persistIntervalMs,
      lastSampleAt: this.lastSampleAt,
      lastSuccessAt: this.lastSuccessAt,
      lastChangeAt: this.lastChangeAt,
      lastPersistAt: this.lastPersistAt,
      sampleAgeMs,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      pointCount: this.points.length,
      historyVersion: this.historyVersion,
    };
  }

  async today({ sinceTs = null } = {}) {
    await this.loadWindow();
    if (!this.running) await this.start();
    if (!this.lastSuccessAt) await this.sample("http_initial").catch(() => {});
    const window = todayWindow(this.now());
    const allPoints = this.points.filter(
      (point) =>
        point.ts >= window.windowStartAt && point.ts <= window.windowEndAt
    );
    const latest = allPoints.at(-1) || null;
    if (!latest && this.lastError) {
      const error = new Error(this.lastError);
      error.code = "crypto_account_equity_unavailable";
      throw error;
    }
    const baseline = allPoints[0]?.equityUsd || latest?.equityUsd || 0;
    const latestEquityUsd = latest?.equityUsd || baseline;
    const todayPnlUsd = latestEquityUsd - baseline;
    const todayPnlPct = baseline ? (todayPnlUsd / baseline) * 100 : 0;
    const normalizedSinceTs = finiteNumber(sinceTs);
    const visible =
      normalizedSinceTs === null
        ? allPoints
        : allPoints.filter((point) => point.ts > normalizedSinceTs);
    const protection = this.status();
    const latestParts = latest ? shanghaiParts(latest.ts) : null;
    return {
      success: true,
      accountScoped: true,
      history: {
        ...window,
        historyVersion: this.historyVersion,
        latestPointTs: latest?.ts || null,
        incremental: normalizedSinceTs !== null,
        sinceTs: normalizedSinceTs,
        latestEquityUsd: Number(latestEquityUsd.toFixed(2)),
        todayPnlUsd: Number(todayPnlUsd.toFixed(2)),
        todayPnlPct: Number(todayPnlPct.toFixed(4)),
        yesterdayBaselineUsd: Number(baseline.toFixed(2)),
        yesterdayChangePct: Number(todayPnlPct.toFixed(4)),
        lastUpdatedAt: latestParts?.time || null,
        lastUpdatedDate: latestParts?.date || null,
        freshness: {
          latestSnapshotAt: latest?.ts || null,
          latestSampleAt: protection.lastSuccessAt,
          ageMs: protection.sampleAgeMs,
          lastError: protection.lastError,
        },
        protection,
        connectionStatus:
          protection.sampleAgeMs !== null &&
          protection.sampleAgeMs <= Math.max(6_000, this.sampleIntervalMs * 4)
            ? "connected"
            : "degraded",
        equityBreakdown: latest?.equityBreakdown || null,
        points: visible.map((point) => {
          const parts = shanghaiParts(point.ts);
          const deltaUsd = point.equityUsd - baseline;
          return {
            ts: point.ts,
            time: parts.time,
            date: parts.date,
            value: Number(point.equityUsd.toFixed(2)),
            totalEquityUsd: Number(point.equityUsd.toFixed(2)),
            deltaUsd: Number(deltaUsd.toFixed(2)),
            deltaPct: baseline
              ? Number(((deltaUsd / baseline) * 100).toFixed(4))
              : 0,
            source: point.source,
            equityMode: EQUITY_MODE,
            persisted: Boolean(point.persisted),
          };
        }),
        accountScoped: true,
        pnlStatus:
          allPoints.length > 1 ? "available" : "initializing_protected_history",
      },
    };
  }
}

module.exports = {
  AccountEquityHistoryStore,
  AccountEquityProtectionService,
  PERSIST_INTERVAL_MS,
  SAMPLE_INTERVAL_MS,
  TASK_DESCRIPTOR,
  normalizeStoredPoint,
  valueFingerprint,
};
