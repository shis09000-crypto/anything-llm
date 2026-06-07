const fs = require("fs");
const path = require("path");
const { GateRestClient } = require("./restClient");
const { safeErrorMessage } = require("./sanitizer");

const TIMEZONE = "Asia/Shanghai";
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;
const HISTORY_DIR = path.resolve(__dirname, "../../storage/crypto-gate");
const HISTORY_FILE = path.join(HISTORY_DIR, "equity-history.jsonl");
const REST_NORMAL_INTERVAL_MS = 2_000;
const REST_SLOW_INTERVAL_MS = 30_000;
const DIRTY_MERGE_MS = 2_000;
const PERSIST_INTERVAL_MS = 60_000;
const RATE_LIMIT_SLOW_THRESHOLD_PCT = 20;
const SCHEDULER_TICK_MS = 500;
const HISTORY_GRANULARITY_MS = REST_NORMAL_INTERVAL_MS;
const TRANSIENT_NEEDLE_DROP_PCT = 30;
const TRANSIENT_NEEDLE_RECOVERY_TOLERANCE_PCT = 12;
const TRANSIENT_NEEDLE_WINDOW_MS = 10 * 60 * 1_000;
const HISTORY_RECORD_TYPE = "total_asset_valuation";
const HISTORY_RECORD_EXCHANGE = "gate";
const HISTORY_RECORD_API_ID = "main_account";
const HISTORY_RECORD_API_NAME = "主账户";
const EQUITY_MODES = new Set(["api_total", "net_equity", "account_sum"]);
const DEFAULT_EQUITY_MODE = "api_total";
const GATE_ACCOUNT_KEYS = [
  "spot",
  "finance",
  "futures",
  "delivery",
  "margin",
  "options",
  "payment",
  "quant",
  "meme_box",
];

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function todayWindow(now = Date.now()) {
  const shifted = new Date(now + SHANGHAI_OFFSET_MS);
  let year = shifted.getUTCFullYear();
  let month = shifted.getUTCMonth();
  let day = shifted.getUTCDate();

  if (shifted.getUTCHours() < 8) {
    const previousDay = new Date(Date.UTC(year, month, day) - 24 * 60 * 60_000);
    year = previousDay.getUTCFullYear();
    month = previousDay.getUTCMonth();
    day = previousDay.getUTCDate();
  }

  const windowStartAt = Date.UTC(year, month, day);
  return {
    timezone: TIMEZONE,
    windowStartAt,
    windowEndAt: windowStartAt + 24 * 60 * 60_000,
  };
}

function shanghaiParts(ts) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(ts)).map((part) => [part.type, part.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    shortTime: `${parts.hour}:${parts.minute}`,
  };
}

function extractTotalEquityUsd(totalBalance) {
  const candidates = [
    totalBalance?.total?.amount,
    totalBalance?.total?.amount_usd,
    totalBalance?.total?.usd,
    totalBalance?.total?.USDT,
    totalBalance?.total,
    totalBalance?.amount,
    totalBalance?.amount_usd,
  ];

  for (const candidate of candidates) {
    const value =
      candidate && typeof candidate === "object"
        ? finiteNumber(candidate.amount || candidate.value || candidate.usd)
        : finiteNumber(candidate);
    if (value !== null) return value;
  }

  if (totalBalance?.details && typeof totalBalance.details === "object") {
    const total = Object.values(totalBalance.details).reduce((sum, item) => {
      const value = finiteNumber(item?.amount || item?.amount_usd || item?.usd);
      return value === null ? sum : sum + value;
    }, 0);
    if (total > 0) return total;
  }

  return null;
}

function normalizeEquityMode(mode) {
  return EQUITY_MODES.has(mode) ? mode : DEFAULT_EQUITY_MODE;
}

function roundUsd(value) {
  const number = finiteNumber(value);
  return number === null ? 0 : Number(number.toFixed(8));
}

function equityBreakdownFromTotalBalance(totalBalance) {
  const details =
    totalBalance?.details && typeof totalBalance.details === "object"
      ? totalBalance.details
      : {};
  const accountAmounts = GATE_ACCOUNT_KEYS.reduce((accounts, key) => {
    accounts[key] = roundUsd(details?.[key]?.amount);
    return accounts;
  }, {});
  const accountSumUsd = Object.values(accountAmounts).reduce(
    (sum, value) => sum + value,
    0
  );
  const apiTotalUsd = roundUsd(
    totalBalance?.total?.amount || extractTotalEquityUsd(totalBalance)
  );
  const unrealizedPnlUsd = roundUsd(totalBalance?.total?.unrealised_pnl);
  const netEquityUsd = roundUsd(apiTotalUsd + unrealizedPnlUsd);

  return {
    apiTotalUsd,
    unrealizedPnlUsd,
    netEquityUsd,
    accountSumUsd: roundUsd(accountSumUsd),
    accountAmounts,
  };
}

function selectEquityUsd(breakdown, equityMode = DEFAULT_EQUITY_MODE) {
  const mode = normalizeEquityMode(equityMode);
  if (mode === "net_equity") return breakdown.netEquityUsd;
  if (mode === "account_sum") return breakdown.accountSumUsd;
  return breakdown.apiTotalUsd;
}

function pointEquityUsd(point, equityMode = DEFAULT_EQUITY_MODE) {
  if (point?.equityBreakdown) {
    return selectEquityUsd(point.equityBreakdown, equityMode);
  }
  return finiteNumber(point?.equityUsd) || 0;
}

function extractRecordTime(record) {
  const value =
    record?.time ||
    record?.create_time ||
    record?.created_at ||
    record?.timestamp ||
    record?.update_time;
  const numeric = finiteNumber(value);
  if (numeric === null) return null;
  return numeric > 10_000_000_000 ? numeric : numeric * 1_000;
}

function extractRecordDeltaUsd(record) {
  const currency = String(
    record?.currency || record?.settle || record?.asset || record?.token || ""
  ).toUpperCase();
  const numericFields = [
    record?.change,
    record?.amount,
    record?.delta,
    record?.balance_change,
    record?.change_amount,
    record?.text,
  ];
  const value = numericFields.map(finiteNumber).find((item) => item !== null);
  if (value === undefined) return null;

  if (!currency || ["USD", "USDT", "USDC"].includes(currency)) return value;
  return null;
}

function normalizeAccountBook(records = []) {
  if (!Array.isArray(records)) return [];
  return records
    .map((record) => ({
      ts: extractRecordTime(record),
      deltaUsd: extractRecordDeltaUsd(record),
    }))
    .filter((record) => record.ts && record.deltaUsd !== null)
    .sort((left, right) => left.ts - right.ts);
}

function compactHistory(points, windowStartAt, windowEndAt) {
  const byGranularity = new Map();
  for (const point of points) {
    if (!Number.isFinite(point.ts) || !Number.isFinite(point.equityUsd))
      continue;
    if (point.ts < windowStartAt || point.ts > windowEndAt) continue;
    const bucket =
      Math.floor(point.ts / HISTORY_GRANULARITY_MS) * HISTORY_GRANULARITY_MS;
    const current = byGranularity.get(bucket);
    if (!current || point.ts >= current.ts) byGranularity.set(bucket, point);
  }
  return [...byGranularity.values()].sort((left, right) => left.ts - right.ts);
}

function isTransientNeedleDrop(previous, point, next) {
  if (!previous || !point || !next) return false;

  const previousValue = pointEquityUsd(previous, DEFAULT_EQUITY_MODE);
  const pointValue = pointEquityUsd(point, DEFAULT_EQUITY_MODE);
  const nextValue = pointEquityUsd(next, DEFAULT_EQUITY_MODE);
  if (previousValue <= 0 || pointValue <= 0 || nextValue <= 0) return false;

  const previousGapMs = point.ts - previous.ts;
  const nextGapMs = next.ts - point.ts;
  if (
    previousGapMs < 0 ||
    nextGapMs < 0 ||
    previousGapMs > TRANSIENT_NEEDLE_WINDOW_MS ||
    nextGapMs > TRANSIENT_NEEDLE_WINDOW_MS
  ) {
    return false;
  }

  const dropPct = ((previousValue - pointValue) / previousValue) * 100;
  const recoveryDistancePct =
    (Math.abs(nextValue - previousValue) / previousValue) * 100;

  return (
    dropPct >= TRANSIENT_NEEDLE_DROP_PCT &&
    recoveryDistancePct <= TRANSIENT_NEEDLE_RECOVERY_TOLERANCE_PCT
  );
}

function filterTransientNeedles(points) {
  if (!Array.isArray(points) || points.length < 3) {
    return { points: points || [], removed: [] };
  }

  const removed = [];
  const filtered = points.filter((point, index) => {
    if (index === 0 || index === points.length - 1) return true;

    const isNeedle = isTransientNeedleDrop(
      points[index - 1],
      point,
      points[index + 1]
    );
    if (isNeedle) removed.push(point);
    return !isNeedle;
  });

  return { points: filtered, removed };
}

function isRealHistoryPoint(point) {
  return Boolean(point) && point.source !== "reconstructed" && !point.estimated;
}

function normalizeHistoryPoint(point) {
  if (!point || typeof point !== "object") return null;
  const equityUsd = finiteNumber(point.equityUsd ?? point.amountUsd);
  const ts = finiteNumber(point.ts);
  if (ts === null || equityUsd === null) return null;

  return {
    ...point,
    ts,
    equityUsd,
    source: point.source || point.refreshSource || "unknown",
    estimated: Boolean(point.estimated),
    equityMode: normalizeEquityMode(point.equityMode),
    type: point.type || HISTORY_RECORD_TYPE,
    exchange: point.exchange || HISTORY_RECORD_EXCHANGE,
    apiId: point.apiId || HISTORY_RECORD_API_ID,
    apiName: point.apiName || HISTORY_RECORD_API_NAME,
  };
}

function persistedHistoryRecord(point) {
  const parts = shanghaiParts(point.ts);
  const amountUsd = Number(point.equityUsd.toFixed(8));
  const refreshSource = point.source || "unknown";

  return {
    ts: point.ts,
    recordedAt: new Date(point.ts).toISOString(),
    date: parts.date,
    time: parts.time,
    timezone: TIMEZONE,
    amountUsd,
    equityUsd: amountUsd,
    type: HISTORY_RECORD_TYPE,
    exchange: HISTORY_RECORD_EXCHANGE,
    apiId: HISTORY_RECORD_API_ID,
    apiName: HISTORY_RECORD_API_NAME,
    refreshSource,
    source: refreshSource,
    equityMode: normalizeEquityMode(point.equityMode),
    estimated: Boolean(point.estimated),
  };
}

function pointResponse(point, baseline, equityMode = DEFAULT_EQUITY_MODE) {
  const equityUsd = pointEquityUsd(point, equityMode);
  const deltaUsd = equityUsd - baseline;
  const deltaPct = baseline ? (deltaUsd / baseline) * 100 : 0;
  const parts = shanghaiParts(point.ts);
  return {
    ts: point.ts,
    time: parts.time,
    date: parts.date,
    value: Number(equityUsd.toFixed(2)),
    deltaUsd: Number(deltaUsd.toFixed(2)),
    deltaPct: Number(deltaPct.toFixed(4)),
    source: point.source,
    type: point.type || HISTORY_RECORD_TYPE,
    exchange: point.exchange || HISTORY_RECORD_EXCHANGE,
    apiId: point.apiId || HISTORY_RECORD_API_ID,
    apiName: point.apiName || HISTORY_RECORD_API_NAME,
    equityMode,
    estimated: Boolean(point.estimated),
  };
}

class GateEquityHistoryService {
  constructor({ restClientFactory = () => new GateRestClient() } = {}) {
    this.restClientFactory = restClientFactory;
    this.history = [];
    this.loaded = false;
    this.initializedWindowStartAt = null;
    this.lastError = null;
    this.schedulerTimer = null;
    this.inFlight = null;
    this.lastRestFetchAt = null;
    this.lastPersistAt = null;
    this.dirtySince = null;
    this.dirtyReason = null;
    this.rateLimitRemainPct = null;
    this.refreshIntervalMs = REST_NORMAL_INTERVAL_MS;
    this.lastRefreshSource = null;
    this.historyVersion = 0;
    this.todayResponseCache = new Map();
    this.todayWindowPointsCache = new Map();
    this.filteredNeedleCount = 0;
  }

  loadFromDisk() {
    if (this.loaded) return;
    if (!fs.existsSync(HISTORY_FILE)) {
      this.loaded = true;
      return;
    }

    const { windowStartAt, windowEndAt } = todayWindow();
    const lines = fs.readFileSync(HISTORY_FILE, "utf8").split(/\r?\n/);
    const compacted = compactHistory(
      lines
        .filter(Boolean)
        .map((line) => {
          try {
            return normalizeHistoryPoint(JSON.parse(line));
          } catch {
            return null;
          }
        })
        .filter(Boolean),
      windowStartAt,
      windowEndAt
    );
    const filtered = filterTransientNeedles(compacted);
    this.history = filtered.points;
    this.filteredNeedleCount = filtered.removed.length;
    this.lastPersistAt = this.history[this.history.length - 1]?.ts || null;
    if (this.history.length) this.historyVersion += 1;
    this.loaded = true;
  }

  persistPoint(point) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.appendFileSync(
      HISTORY_FILE,
      `${JSON.stringify(persistedHistoryRecord(point))}\n`
    );
  }

  appendPoint({
    ts = Date.now(),
    equityUsd,
    source,
    estimated = false,
    equityBreakdown = null,
    equityMode = DEFAULT_EQUITY_MODE,
    persist = false,
  }) {
    const value = finiteNumber(equityUsd);
    if (value === null) return null;

    const { windowStartAt, windowEndAt } = todayWindow(ts);
    const previousHistory = this.history;
    const point = {
      ts,
      equityUsd: Number(value.toFixed(8)),
      source,
      estimated,
      equityMode: normalizeEquityMode(equityMode),
      type: HISTORY_RECORD_TYPE,
      exchange: HISTORY_RECORD_EXCHANGE,
      apiId: HISTORY_RECORD_API_ID,
      apiName: HISTORY_RECORD_API_NAME,
      ...(equityBreakdown ? { equityBreakdown } : {}),
    };
    const compacted = compactHistory(
      [...this.history, point],
      windowStartAt,
      windowEndAt
    );
    const filtered = filterTransientNeedles(compacted);
    this.history = filtered.points;
    this.filteredNeedleCount = filtered.removed.length;
    if (this.history !== previousHistory) {
      this.historyVersion += 1;
      this.todayResponseCache.clear();
      this.todayWindowPointsCache.clear();
    }
    if (persist) {
      this.persistPoint(point);
      this.lastPersistAt = ts;
    }
    return point;
  }

  updateRateLimit(rateLimit) {
    if (!rateLimit) return;
    if (
      rateLimit.remainPct === null ||
      rateLimit.remainPct === undefined ||
      !Number.isFinite(Number(rateLimit.remainPct))
    ) {
      this.rateLimitRemainPct = null;
      this.refreshIntervalMs = REST_NORMAL_INTERVAL_MS;
      return;
    }

    this.rateLimitRemainPct = Number(rateLimit.remainPct);
    this.refreshIntervalMs =
      this.rateLimitRemainPct < RATE_LIMIT_SLOW_THRESHOLD_PCT
        ? REST_SLOW_INTERVAL_MS
        : REST_NORMAL_INTERVAL_MS;
  }

  async fetchCurrentEquity() {
    const result = await this.restClientFactory().getTotalBalanceRaw();
    this.updateRateLimit(result.rateLimit);
    if (!result.success) throw new Error(result.safeErrorMessage);
    const equityBreakdown = equityBreakdownFromTotalBalance(result.data);
    const equityUsd = selectEquityUsd(equityBreakdown, DEFAULT_EQUITY_MODE);
    if (equityUsd === null) {
      throw new Error("Gate total equity amount was not found.");
    }
    return {
      equityUsd,
      equityBreakdown,
    };
  }

  latestPoint({ realOnly = false } = {}) {
    this.loadFromDisk();
    const { windowStartAt, windowEndAt } = todayWindow();
    const compacted = compactHistory(
      realOnly ? this.history.filter(isRealHistoryPoint) : this.history,
      windowStartAt,
      windowEndAt
    );
    const { points } = filterTransientNeedles(compacted);
    return points[points.length - 1] || null;
  }

  hasCurrentWindowPoint() {
    return Boolean(this.latestPoint({ realOnly: true }));
  }

  nextAllowedRestAt() {
    if (!this.lastRestFetchAt) return Date.now();
    return this.lastRestFetchAt + this.refreshIntervalMs;
  }

  canFetchRest(now = Date.now()) {
    return !this.inFlight && now >= this.nextAllowedRestAt();
  }

  async fetchAccountBookDeltas(windowStartAt, windowEndAt) {
    const from = Math.floor(windowStartAt / 1_000);
    const to = Math.floor(windowEndAt / 1_000);
    const client = this.restClientFactory();
    const [spot, futures] = await Promise.all([
      client.getSpotAccountBook({ from, to }),
      client.getFuturesUsdtAccountBook({ from, to }),
    ]);

    return [
      ...(spot.success ? normalizeAccountBook(spot.data) : []),
      ...(futures.success ? normalizeAccountBook(futures.data) : []),
    ].sort((left, right) => left.ts - right.ts);
  }

  async initializeToday() {
    this.loadFromDisk();
    const { windowStartAt } = todayWindow();
    if (this.initializedWindowStartAt === windowStartAt) return;

    const currentEquity = await this.fetchCurrentEquity();
    const now = Date.now();

    this.appendPoint({
      ts: now,
      equityUsd: currentEquity.equityUsd,
      source: "snapshot",
      estimated: false,
      equityMode: DEFAULT_EQUITY_MODE,
      equityBreakdown: currentEquity.equityBreakdown,
      persist: true,
    });
    this.initializedWindowStartAt = windowStartAt;
  }

  async recordSnapshot(source = "snapshot", { persist = false } = {}) {
    if (this.inFlight) return this.inFlight;
    const now = Date.now();
    if (!this.canFetchRest(now)) return null;

    this.inFlight = (async () => {
      try {
        this.loadFromDisk();
        const currentEquity = await this.fetchCurrentEquity();
        const ts = Date.now();
        this.lastRestFetchAt = ts;
        this.lastRefreshSource = source;
        this.lastError = null;
        return this.appendPoint({
          ts,
          equityUsd: currentEquity.equityUsd,
          source,
          estimated: false,
          equityBreakdown: currentEquity.equityBreakdown,
          equityMode: DEFAULT_EQUITY_MODE,
          persist,
        });
      } catch (error) {
        this.lastError = safeErrorMessage(error);
        this.lastRefreshSource = source;
        throw error;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  markDirty(reason = "ws") {
    const now = Date.now();
    this.dirtySince = this.dirtySince || now;
    this.dirtyReason = reason;
    this.startScheduler();
  }

  scheduleRefresh(source = "ws") {
    this.markDirty(source);
  }

  async schedulerTick() {
    const now = Date.now();

    if (!this.hasCurrentWindowPoint() && this.canFetchRest(now)) {
      await this.recordSnapshot("scheduler_init", { persist: true }).catch(
        () => {}
      );
      return;
    }

    if (this.dirtySince && now - this.dirtySince < DIRTY_MERGE_MS) {
      return;
    }

    if (
      this.dirtySince &&
      now - this.dirtySince >= DIRTY_MERGE_MS &&
      this.canFetchRest(now)
    ) {
      const source = `ws_dirty:${this.dirtyReason || "event"}`;
      this.dirtySince = null;
      this.dirtyReason = null;
      await this.recordSnapshot(source, { persist: false }).catch(() => {});
      return;
    }

    if (
      (!this.lastPersistAt ||
        now - this.lastPersistAt >= PERSIST_INTERVAL_MS) &&
      this.canFetchRest(now)
    ) {
      await this.recordSnapshot("periodic_persist", { persist: true }).catch(
        () => {}
      );
      return;
    }

    if (this.canFetchRest(now)) {
      await this.recordSnapshot("rest_refresh", { persist: false }).catch(
        () => {}
      );
    }
  }

  startScheduler() {
    if (this.schedulerTimer) return;
    this.schedulerTimer = setInterval(() => {
      this.schedulerTick().catch(() => {});
    }, SCHEDULER_TICK_MS);
    this.schedulerTick().catch(() => {});
  }

  stopScheduler() {
    if (!this.schedulerTimer) return;
    clearInterval(this.schedulerTimer);
    this.schedulerTimer = null;
  }

  startPolling() {
    this.startScheduler();
  }

  stopPolling() {
    this.stopScheduler();
  }

  freshness() {
    const latest = this.latestPoint({ realOnly: true });
    const now = Date.now();
    const nextAllowedRestAt = this.nextAllowedRestAt();

    return {
      latestSnapshotAt: latest?.ts || null,
      ageMs: latest?.ts ? Math.max(0, now - latest.ts) : null,
      lastRefreshSource: this.lastRefreshSource,
      dirty: Boolean(this.dirtySince),
      dirtySince: this.dirtySince,
      dirtyReason: this.dirtyReason,
      nextAllowedRestAt,
      rateLimitRemainPct: this.rateLimitRemainPct,
      refreshIntervalMs: this.refreshIntervalMs,
      rateLimitMode:
        this.refreshIntervalMs === REST_SLOW_INTERVAL_MS ? "slow" : "normal",
      lastError: this.lastError,
    };
  }

  cachedTodayPoints(points, baseline, selectedEquityMode) {
    const cacheKey = `${selectedEquityMode}:${this.historyVersion}`;
    const cached = this.todayResponseCache.get(cacheKey);
    if (cached) return cached;

    const mappedPoints = points.map((point) =>
      pointResponse(point, baseline, selectedEquityMode)
    );
    const cachedValue = {
      mappedPoints,
      latestPointTs: mappedPoints[mappedPoints.length - 1]?.ts || null,
    };
    this.todayResponseCache.set(cacheKey, cachedValue);
    return cachedValue;
  }

  cachedTodayWindowPoints(window) {
    const cacheKey = `${window.windowStartAt}:${window.windowEndAt}:${this.historyVersion}`;
    const cached = this.todayWindowPointsCache.get(cacheKey);
    if (cached) return cached;

    const compacted = compactHistory(
      this.history.filter(isRealHistoryPoint),
      window.windowStartAt,
      window.windowEndAt
    );
    const filtered = filterTransientNeedles(compacted);
    const points = filtered.points;
    this.filteredNeedleCount = filtered.removed.length;
    this.todayWindowPointsCache.set(cacheKey, points);
    return points;
  }

  async today({ equityMode = DEFAULT_EQUITY_MODE, sinceTs = null } = {}) {
    const selectedEquityMode = normalizeEquityMode(equityMode);
    const normalizedSinceTs = finiteNumber(sinceTs);
    const window = todayWindow();
    this.loadFromDisk();
    const points = this.cachedTodayWindowPoints(window);
    const latest = points[points.length - 1] || null;

    const visiblePoints = points;
    const baselinePoint = visiblePoints[0] || latest;
    const latestBreakdown = latest?.equityBreakdown || null;
    const baseline =
      pointEquityUsd(baselinePoint, selectedEquityMode) ||
      pointEquityUsd(latest, selectedEquityMode) ||
      0;
    const latestEquityUsd = latest
      ? pointEquityUsd(latest, selectedEquityMode)
      : baseline;
    const todayPnlUsd = latestEquityUsd - baseline;
    const todayPnlPct = baseline ? (todayPnlUsd / baseline) * 100 : 0;
    const cachedPoints = this.cachedTodayPoints(
      visiblePoints,
      baseline,
      selectedEquityMode
    );
    const responsePoints =
      normalizedSinceTs === null
        ? cachedPoints.mappedPoints
        : cachedPoints.mappedPoints.filter(
            (point) => point.ts > normalizedSinceTs
          );

    return {
      ...window,
      historyVersion: this.historyVersion,
      latestPointTs: cachedPoints.latestPointTs,
      incremental: normalizedSinceTs !== null,
      sinceTs: normalizedSinceTs,
      yesterdayBaselineUsd: Number(baseline.toFixed(2)),
      latestEquityUsd: Number(latestEquityUsd.toFixed(2)),
      todayPnlUsd: Number(todayPnlUsd.toFixed(2)),
      todayPnlPct: Number(todayPnlPct.toFixed(4)),
      yesterdayChangePct: Number(todayPnlPct.toFixed(4)),
      lastUpdatedAt: latest ? shanghaiParts(latest.ts).time : null,
      lastUpdatedDate: latest ? shanghaiParts(latest.ts).date : null,
      filteredNeedles: this.filteredNeedleCount,
      lastError: this.lastError,
      freshness: this.freshness(),
      equityBreakdown: latestBreakdown
        ? {
            ...latestBreakdown,
            selectedEquityUsd: Number(latestEquityUsd.toFixed(2)),
            equityMode: selectedEquityMode,
          }
        : null,
      points: responsePoints,
    };
  }
}

const cryptoGateEquityHistoryService = new GateEquityHistoryService();

module.exports = {
  GateEquityHistoryService,
  compactHistory,
  cryptoGateEquityHistoryService,
  equityBreakdownFromTotalBalance,
  extractTotalEquityUsd,
  filterTransientNeedles,
  isRealHistoryPoint,
  normalizeEquityMode,
  normalizeHistoryPoint,
  persistedHistoryRecord,
  selectEquityUsd,
  todayWindow,
};
