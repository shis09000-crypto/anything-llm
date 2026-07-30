const WebSocket = require("ws");
const { GATE_WS_SPOT_URL } = require("./constants");
const { GatePublicMarketClient } = require("./publicMarketClient");

const EVIDENCE_FORMULA_VERSION = "crypto-market-evidence-v1";
const TRADE_RETENTION_MS = 30 * 60 * 1_000;
const COLLECTOR_IDLE_MS = 10 * 60 * 1_000;
const MAX_HOT_PAIRS = 20;
const DEPTH_SAMPLE_INTERVAL_MS = 1_000;
const DEPTH_LEVELS = 100;
const DERIVATIVES_CACHE_MS = 60_000;
const RECONNECT_MAX_MS = 30_000;
const WINDOW_MS = Object.freeze({
  "1m": 60 * 1_000,
  "5m": 5 * 60 * 1_000,
  "15m": 15 * 60 * 1_000,
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rounded(value, digits = 10) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function normalizedPair(pair) {
  const value = String(pair || "")
    .trim()
    .toUpperCase()
    .replace("-", "_");
  if (!/^[A-Z0-9]{2,20}_[A-Z0-9]{2,20}$/.test(value)) {
    const error = new Error("Unsupported or invalid Gate market pair.");
    error.code = "invalid_pair";
    throw error;
  }
  return value;
}

function mean(values = []) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function median(values = []) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return null;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2
    ? valid[middle]
    : (valid[middle - 1] + valid[middle]) / 2;
}

function standardDeviation(values = []) {
  const valid = values.filter(Number.isFinite);
  if (valid.length < 2) return null;
  const average = mean(valid);
  const variance =
    valid.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    (valid.length - 1);
  return Math.sqrt(variance);
}

function zScore(value, values = []) {
  const average = mean(values);
  const deviation = standardDeviation(values);
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(average) ||
    !Number.isFinite(deviation) ||
    deviation === 0
  )
    return null;
  return (value - average) / deviation;
}

function normalizeTrade(raw = {}) {
  const timestampValue =
    raw.create_time_ms ?? raw.time_ms ?? raw.create_time ?? raw.time;
  const numericTimestamp = finite(timestampValue);
  const timestampMs =
    numericTimestamp === null
      ? null
      : numericTimestamp > 10_000_000_000
        ? Math.floor(numericTimestamp)
        : Math.floor(numericTimestamp * 1_000);
  const amount = finite(raw.amount);
  const price = finite(raw.price);
  const side = String(raw.side || "").toLowerCase();
  if (
    timestampMs === null ||
    amount === null ||
    price === null ||
    amount <= 0 ||
    price <= 0 ||
    !["buy", "sell"].includes(side)
  )
    return null;
  return {
    id: String(raw.id_market ?? raw.sequence_id ?? raw.id ?? ""),
    timestampMs,
    side,
    amount,
    price,
    quoteNotional: amount * price,
  };
}

function normalizeBookSide(levels = []) {
  return levels
    .map(([price, amount]) => [finite(price), finite(amount)])
    .filter(
      ([price, amount]) =>
        Number.isFinite(price) &&
        Number.isFinite(amount) &&
        price > 0 &&
        amount >= 0
    );
}

function tradeWindow(trades = [], windowMs, now = Date.now()) {
  const selected = trades.filter(
    (trade) =>
      now - trade.timestampMs >= 0 && now - trade.timestampMs <= windowMs
  );
  const buyQuote = selected
    .filter(({ side }) => side === "buy")
    .reduce((sum, trade) => sum + trade.quoteNotional, 0);
  const sellQuote = selected
    .filter(({ side }) => side === "sell")
    .reduce((sum, trade) => sum + trade.quoteNotional, 0);
  const totalQuote = buyQuote + sellQuote;
  return {
    windowMs,
    tradeCount: selected.length,
    buyQuoteNotional: rounded(buyQuote),
    sellQuoteNotional: rounded(sellQuote),
    totalQuoteNotional: rounded(totalQuote),
    takerBuyRatio: totalQuote > 0 ? rounded(buyQuote / totalQuote) : null,
    cumulativeVolumeDelta: rounded(buyQuote - sellQuote),
    averageTradeQuote:
      selected.length > 0 ? rounded(totalQuote / selected.length) : null,
    oldestTradeTimestampMs: selected[0]?.timestampMs || null,
    newestTradeTimestampMs: selected[selected.length - 1]?.timestampMs || null,
    status: selected.length >= 10 ? "available" : "insufficient",
  };
}

function depthMetrics({ bids = [], asks = [], timestampMs = Date.now() }) {
  const normalizedBids = normalizeBookSide(bids)
    .filter(([, amount]) => amount > 0)
    .sort((left, right) => right[0] - left[0]);
  const normalizedAsks = normalizeBookSide(asks)
    .filter(([, amount]) => amount > 0)
    .sort((left, right) => left[0] - right[0]);
  const [bestBidPrice, bestBidAmount] = normalizedBids[0] || [];
  const [bestAskPrice, bestAskAmount] = normalizedAsks[0] || [];
  if (
    !Number.isFinite(bestBidPrice) ||
    !Number.isFinite(bestAskPrice) ||
    bestAskPrice < bestBidPrice
  )
    return null;
  const mid = (bestBidPrice + bestAskPrice) / 2;
  const spreadBps =
    mid > 0 ? ((bestAskPrice - bestBidPrice) / mid) * 10_000 : null;
  const microPrice =
    bestBidAmount + bestAskAmount > 0
      ? (bestAskPrice * bestBidAmount + bestBidPrice * bestAskAmount) /
        (bestBidAmount + bestAskAmount)
      : null;
  const depth = {};
  for (const bps of [10, 25, 50]) {
    const bidNotional = normalizedBids
      .filter(([price]) => ((mid - price) / mid) * 10_000 <= bps)
      .reduce((sum, [price, amount]) => sum + price * amount, 0);
    const askNotional = normalizedAsks
      .filter(([price]) => ((price - mid) / mid) * 10_000 <= bps)
      .reduce((sum, [price, amount]) => sum + price * amount, 0);
    const total = bidNotional + askNotional;
    depth[`${bps}bps`] = {
      bidQuoteNotional: rounded(bidNotional),
      askQuoteNotional: rounded(askNotional),
      imbalance:
        total > 0 ? rounded((bidNotional - askNotional) / total) : null,
    };
  }
  return {
    timestampMs,
    midPrice: rounded(mid),
    spreadBps: rounded(spreadBps),
    microPrice: rounded(microPrice),
    microPriceDeviationBps:
      Number.isFinite(microPrice) && mid > 0
        ? rounded(((microPrice - mid) / mid) * 10_000)
        : null,
    depth,
  };
}

function depthWindow(samples = [], windowMs, now = Date.now()) {
  const selected = samples.filter(
    (sample) =>
      now - sample.timestampMs >= 0 && now - sample.timestampMs <= windowMs
  );
  const latest = selected[selected.length - 1] || null;
  const summary = {
    windowMs,
    sampleCount: selected.length,
    spreadBpsMedian: rounded(median(selected.map((item) => item.spreadBps))),
    microPriceDeviationBpsMedian: rounded(
      median(selected.map((item) => item.microPriceDeviationBps))
    ),
    depth: {},
    latest,
    status: selected.length >= 30 ? "available" : "warming",
  };
  for (const key of ["10bps", "25bps", "50bps"]) {
    const imbalances = selected.map((item) => item.depth?.[key]?.imbalance);
    const valid = imbalances.filter(Number.isFinite);
    const positive = valid.filter((value) => value > 0).length;
    const negative = valid.filter((value) => value < 0).length;
    summary.depth[key] = {
      imbalanceMedian: rounded(median(valid)),
      positiveSampleRatio:
        valid.length > 0 ? rounded(positive / valid.length) : null,
      negativeSampleRatio:
        valid.length > 0 ? rounded(negative / valid.length) : null,
      latestBidQuoteNotional: latest?.depth?.[key]?.bidQuoteNotional ?? null,
      latestAskQuoteNotional: latest?.depth?.[key]?.askQuoteNotional ?? null,
    };
  }
  return summary;
}

class GateSpotEvidenceCollector {
  constructor({
    pair,
    client = new GatePublicMarketClient(),
    WebSocketImpl = WebSocket,
    now = () => Date.now(),
  }) {
    this.pair = normalizedPair(pair);
    this.client = client;
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.lastAccessAt = now();
    this.trades = [];
    this.tradeIds = new Set();
    this.bids = new Map();
    this.asks = new Map();
    this.bookId = null;
    this.depthBuffer = [];
    this.depthSamples = [];
    this.lastDepthSampleAt = 0;
    this.ws = null;
    this.status = "idle";
    this.lastError = null;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.sampleTimer = null;
    this.warmupPromise = null;
    this.resyncPromise = null;
    this.resyncRequested = false;
    this.stopped = false;
  }

  touch() {
    this.lastAccessAt = this.now();
  }

  async ensureStarted() {
    this.touch();
    if (this.warmupPromise) return this.warmupPromise;
    this.startSampling();
    this.connect();
    this.warmupPromise = Promise.allSettled([
      this.backfillTrades(),
      this.resyncBook(),
    ]).then(() => undefined);
    return this.warmupPromise;
  }

  startSampling() {
    if (this.sampleTimer || this.stopped) return;
    this.sampleTimer = setInterval(
      () => this.sampleDepth(),
      DEPTH_SAMPLE_INTERVAL_MS
    );
    this.sampleTimer.unref?.();
  }

  async backfillTrades() {
    const now = this.now();
    const result = await this.client.getSpotTradesRaw({
      currencyPair: this.pair,
      limit: 1_000,
      from: Math.floor((now - WINDOW_MS["15m"]) / 1_000),
      to: Math.floor(now / 1_000),
    });
    if (!result?.success) {
      this.lastError =
        result?.errorCode ||
        result?.safeErrorMessage ||
        "trade_backfill_failed";
      return;
    }
    for (const raw of Array.isArray(result.data) ? result.data : [])
      this.addTrade(raw);
    this.prune();
  }

  async resyncBook() {
    if (this.resyncPromise) return this.resyncPromise;
    this.resyncPromise = (async () => {
      const result = await this.client.getSpotOrderBookRaw({
        currencyPair: this.pair,
        limit: DEPTH_LEVELS,
        withId: true,
      });
      if (!result?.success) {
        this.lastError =
          result?.errorCode || result?.safeErrorMessage || "book_resync_failed";
        return;
      }
      const data = result.data || {};
      this.bids = new Map(normalizeBookSide(data.bids));
      this.asks = new Map(normalizeBookSide(data.asks));
      this.bookId = finite(data.id);
      const buffered = this.depthBuffer
        .splice(0)
        .sort((left, right) => Number(left.U || 0) - Number(right.U || 0));
      for (const update of buffered) {
        if (!this.applyDepthUpdate(update)) break;
      }
      this.sampleDepth(true);
      if (Number.isFinite(this.bookId)) this.lastError = null;
    })().finally(() => {
      this.resyncPromise = null;
      if (this.resyncRequested && !this.stopped) {
        this.resyncRequested = false;
        queueMicrotask(() => this.resyncBook().catch(() => {}));
      }
    });
    return this.resyncPromise;
  }

  addTrade(raw) {
    const trade = normalizeTrade(raw);
    if (!trade) return;
    const id =
      trade.id ||
      `${trade.timestampMs}:${trade.side}:${trade.amount}:${trade.price}`;
    if (this.tradeIds.has(id)) return;
    this.tradeIds.add(id);
    this.trades.push({ ...trade, id });
    this.trades.sort((left, right) => left.timestampMs - right.timestampMs);
    this.prune();
  }

  applyDepthUpdate(update = {}) {
    const firstId = finite(update.U);
    const lastId = finite(update.u);
    if (update.full === true) {
      this.bids = new Map(normalizeBookSide(update.b));
      this.asks = new Map(normalizeBookSide(update.a));
      this.bookId = lastId;
      this.sampleDepth();
      return true;
    }
    if (this.bookId === null) {
      this.depthBuffer.push(update);
      return false;
    }
    if (
      Number.isFinite(firstId) &&
      Number.isFinite(lastId) &&
      (lastId < this.bookId + 1 || firstId > this.bookId + 1)
    ) {
      if (lastId < this.bookId + 1) return true;
      this.lastError = "order_book_sequence_gap";
      this.depthBuffer = [update];
      this.bookId = null;
      if (this.resyncPromise) this.resyncRequested = true;
      else this.resyncBook().catch(() => {});
      return false;
    }
    for (const [price, amount] of normalizeBookSide(update.b)) {
      if (amount === 0) this.bids.delete(price);
      else this.bids.set(price, amount);
    }
    for (const [price, amount] of normalizeBookSide(update.a)) {
      if (amount === 0) this.asks.delete(price);
      else this.asks.set(price, amount);
    }
    if (Number.isFinite(lastId)) this.bookId = lastId;
    this.sampleDepth();
    return true;
  }

  sampleDepth(force = false) {
    const now = this.now();
    if (!Number.isFinite(this.bookId)) return;
    if (!force && now - this.lastDepthSampleAt < DEPTH_SAMPLE_INTERVAL_MS)
      return;
    const sample = depthMetrics({
      bids: Array.from(this.bids.entries()),
      asks: Array.from(this.asks.entries()),
      timestampMs: now,
    });
    if (!sample) return;
    this.lastDepthSampleAt = now;
    this.depthSamples.push(sample);
    this.prune();
  }

  prune() {
    const cutoff = this.now() - TRADE_RETENTION_MS;
    this.trades = this.trades.filter(
      ({ timestampMs }) => timestampMs >= cutoff
    );
    this.tradeIds = new Set(this.trades.map(({ id }) => id));
    this.depthSamples = this.depthSamples.filter(
      ({ timestampMs }) => timestampMs >= cutoff
    );
  }

  connect() {
    if (this.stopped || this.ws) return;
    this.status = "connecting";
    const ws = new this.WebSocketImpl(GATE_WS_SPOT_URL);
    this.ws = ws;
    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.status = "connected";
      this.lastError = null;
      this.reconnectAttempt = 0;
      for (const [channel, payload] of [
        ["spot.trades", [this.pair]],
        ["spot.order_book_update", [this.pair, "100ms"]],
      ])
        ws.send(
          JSON.stringify({
            time: Math.floor(this.now() / 1_000),
            channel,
            event: "subscribe",
            payload,
          })
        );
    });
    ws.on("message", (raw) => {
      let message = null;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message?.event !== "update") return;
      if (message.channel === "spot.trades") {
        const values = Array.isArray(message.result)
          ? message.result
          : [message.result];
        for (const trade of values) this.addTrade(trade);
      } else if (message.channel === "spot.order_book_update") {
        this.applyDepthUpdate(message.result || {});
      }
    });
    ws.on("error", (error) => {
      this.lastError = error?.message || "websocket_error";
      this.status = "error";
    });
    ws.on("close", () => {
      if (this.ws === ws) this.ws = null;
      if (this.stopped) return;
      this.status = "disconnected";
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.stopped) return;
    const delay = Math.min(
      1_000 * 2 ** Math.min(this.reconnectAttempt, 5),
      RECONNECT_MAX_MS
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  snapshot() {
    this.touch();
    this.prune();
    const now = this.now();
    const trades = Object.fromEntries(
      Object.entries(WINDOW_MS).map(([id, windowMs]) => [
        id,
        tradeWindow(this.trades, windowMs, now),
      ])
    );
    const depth = Object.fromEntries(
      Object.entries(WINDOW_MS).map(([id, windowMs]) => [
        id,
        depthWindow(this.depthSamples, windowMs, now),
      ])
    );
    const tradeAvailable = Object.values(trades).some(
      ({ status }) => status === "available"
    );
    const depthAvailable = Object.values(depth).some(
      ({ status }) => status === "available"
    );
    return {
      source: "gate_public_spot",
      pair: this.pair,
      status:
        tradeAvailable && depthAvailable
          ? "complete"
          : tradeAvailable || this.depthSamples.length
            ? "warming"
            : "unavailable",
      asOf: now,
      wsStatus: this.status,
      lastError: this.lastError,
      orderBook: {
        synchronized: Number.isFinite(this.bookId),
        updateId: this.bookId,
        sampleIntervalMs: DEPTH_SAMPLE_INTERVAL_MS,
        windows: depth,
      },
      tradeFlow: {
        sideSemantics: "gate_public_taker_side",
        retentionMs: TRADE_RETENTION_MS,
        windows: trades,
      },
      dataQuality: {
        tradeCountRetained: this.trades.length,
        depthSamplesRetained: this.depthSamples.length,
        oldestTradeTimestampMs: this.trades[0]?.timestampMs || null,
        newestTradeTimestampMs:
          this.trades[this.trades.length - 1]?.timestampMs || null,
      },
    };
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    this.reconnectTimer = null;
    this.sampleTimer = null;
    if (this.ws) {
      try {
        this.ws.close(1_000, "idle");
      } catch {}
    }
    this.ws = null;
    this.status = "idle";
  }
}

class GateSpotEvidenceCollectorManager {
  constructor({
    maxPairs = MAX_HOT_PAIRS,
    idleMs = COLLECTOR_IDLE_MS,
    collectorFactory = (options) => new GateSpotEvidenceCollector(options),
    now = () => Date.now(),
  } = {}) {
    this.maxPairs = maxPairs;
    this.idleMs = idleMs;
    this.collectorFactory = collectorFactory;
    this.now = now;
    this.collectors = new Map();
    this.cleanupTimer = setInterval(
      () => this.cleanup(),
      Math.min(60_000, Math.max(1_000, Math.floor(idleMs / 2)))
    );
    this.cleanupTimer.unref?.();
  }

  get(pair) {
    const normalized = normalizedPair(pair);
    let collector = this.collectors.get(normalized);
    if (!collector) {
      this.evictIfNeeded();
      collector = this.collectorFactory({ pair: normalized });
      this.collectors.set(normalized, collector);
    }
    collector.touch?.();
    return collector;
  }

  evictIfNeeded() {
    if (this.collectors.size < this.maxPairs) return;
    const oldest = Array.from(this.collectors.entries()).sort(
      (left, right) =>
        Number(left[1].lastAccessAt || 0) - Number(right[1].lastAccessAt || 0)
    )[0];
    if (!oldest) return;
    oldest[1].stop?.();
    this.collectors.delete(oldest[0]);
  }

  cleanup() {
    const cutoff = this.now() - this.idleMs;
    for (const [pair, collector] of this.collectors.entries()) {
      if (Number(collector.lastAccessAt || 0) >= cutoff) continue;
      collector.stop?.();
      this.collectors.delete(pair);
    }
  }

  async evidence(pair) {
    const collector = this.get(pair);
    await collector.ensureStarted();
    return collector.snapshot();
  }

  stop() {
    clearInterval(this.cleanupTimer);
    for (const collector of this.collectors.values()) collector.stop?.();
    this.collectors.clear();
  }
}

function pointAtOrBefore(rows, timestampMs) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].timestampMs <= timestampMs) return rows[index];
  }
  return null;
}

function percentChange(latest, previous) {
  if (!Number.isFinite(latest) || !Number.isFinite(previous) || previous === 0)
    return null;
  return ((latest - previous) / Math.abs(previous)) * 100;
}

function normalizeContractStats(data = []) {
  return (Array.isArray(data) ? data : [])
    .map((row) => ({
      timestampMs: Number(row.time) * 1_000,
      openInterestUsd: finite(row.open_interest_usd),
      takerLongShortRatio: finite(row.lsr_taker),
      accountLongShortRatio: finite(row.lsr_account),
      topAccountLongShortRatio: finite(row.top_lsr_account),
      topSizeLongShortRatio: finite(row.top_lsr_size),
      longLiquidationUsd: finite(row.long_liq_usd_new ?? row.long_liq_usd),
      shortLiquidationUsd: finite(row.short_liq_usd_new ?? row.short_liq_usd),
      markPrice: finite(row.mark_price),
    }))
    .filter(({ timestampMs }) => Number.isFinite(timestampMs))
    .sort((left, right) => left.timestampMs - right.timestampMs);
}

function liquidationWindow(rows, windowMs, now) {
  const selected = rows.filter(
    ({ timestampMs }) => now - timestampMs >= 0 && now - timestampMs <= windowMs
  );
  return {
    longLiquidationUsd: rounded(
      selected.reduce(
        (sum, row) => sum + Number(row.longLiquidationUsd || 0),
        0
      )
    ),
    shortLiquidationUsd: rounded(
      selected.reduce(
        (sum, row) => sum + Number(row.shortLiquidationUsd || 0),
        0
      )
    ),
    sampleCount: selected.length,
  };
}

async function fetchDerivativesEvidence({
  pair,
  spotPrice = null,
  client = new GatePublicMarketClient(),
  now = Date.now(),
}) {
  const contract = normalizedPair(pair);
  const [contractResult, statsResult, fundingResult] = await Promise.all([
    client.getFuturesUsdtContractRaw({ contract }),
    client.getFuturesUsdtContractStatsRaw({
      contract,
      interval: "5m",
      limit: 300,
      from: Math.floor((now - (24 * 60 * 60 + 10 * 60) * 1_000) / 1_000),
    }),
    client.getFuturesUsdtFundingRatesRaw({ contract, limit: 30 }),
  ]);
  if (
    contractResult?.success === false &&
    [400, 404].includes(Number(contractResult.statusCode))
  )
    return {
      source: "gate_public_usdt_perpetual",
      contract,
      status: "unavailable",
      reason: "contract_unavailable",
      asOf: now,
    };

  const failures = [];
  for (const [source, result] of [
    ["contract", contractResult],
    ["contract_stats", statsResult],
    ["funding_rate", fundingResult],
  ]) {
    if (result?.success) continue;
    failures.push({
      source,
      error:
        result?.errorCode ||
        (result?.statusCode
          ? `http_${result.statusCode}`
          : "provider_unavailable"),
    });
  }
  const contractData = contractResult?.success ? contractResult.data || {} : {};
  const stats = statsResult?.success
    ? normalizeContractStats(statsResult.data)
    : [];
  const latestStats = stats[stats.length - 1] || null;
  const oiChanges = {};
  for (const [id, windowMs] of [
    ["1h", 60 * 60 * 1_000],
    ["4h", 4 * 60 * 60 * 1_000],
    ["24h", 24 * 60 * 60 * 1_000],
  ]) {
    const previous = pointAtOrBefore(stats, now - windowMs);
    oiChanges[id] = rounded(
      percentChange(latestStats?.openInterestUsd, previous?.openInterestUsd)
    );
  }
  const fundingRows = (
    fundingResult?.success && Array.isArray(fundingResult.data)
      ? fundingResult.data
      : []
  )
    .map((row) => ({
      timestampMs: Number(row.t) * 1_000,
      rate: finite(row.r),
    }))
    .filter(
      ({ timestampMs, rate }) =>
        Number.isFinite(timestampMs) && Number.isFinite(rate)
    )
    .sort((left, right) => left.timestampMs - right.timestampMs);
  const fundingValues = fundingRows.map(({ rate }) => rate);
  const latestFunding = fundingRows[fundingRows.length - 1] || null;
  const markPrice =
    finite(contractData.mark_price) ?? latestStats?.markPrice ?? null;
  const indexPrice = finite(contractData.index_price);
  const latestPrice = finite(contractData.last_price);
  const numericSpotPrice = finite(spotPrice);
  const basisPct = (value, reference) =>
    Number.isFinite(value) && Number.isFinite(reference) && reference !== 0
      ? rounded(((value - reference) / reference) * 100)
      : null;
  const ratioSeries = (field) =>
    stats.map((row) => row[field]).filter(Number.isFinite);
  const positioning = {
    takerLongShortRatio: rounded(latestStats?.takerLongShortRatio),
    takerLongShortRatioZScore24h: rounded(
      zScore(
        latestStats?.takerLongShortRatio,
        ratioSeries("takerLongShortRatio")
      )
    ),
    accountLongShortRatio: rounded(latestStats?.accountLongShortRatio),
    accountLongShortRatioZScore24h: rounded(
      zScore(
        latestStats?.accountLongShortRatio,
        ratioSeries("accountLongShortRatio")
      )
    ),
    topAccountLongShortRatio: rounded(latestStats?.topAccountLongShortRatio),
    topSizeLongShortRatio: rounded(latestStats?.topSizeLongShortRatio),
  };
  const availableSources = [contractResult, statsResult, fundingResult].filter(
    ({ success } = {}) => success
  ).length;
  return {
    source: "gate_public_usdt_perpetual",
    contract,
    status:
      availableSources === 3
        ? "complete"
        : availableSources > 0
          ? "partial"
          : "unavailable",
    asOf: now,
    failures,
    market: {
      lastPrice: rounded(latestPrice),
      markPrice: rounded(markPrice),
      indexPrice: rounded(indexPrice),
      markVsSpotBasisPct: basisPct(markPrice, numericSpotPrice),
      indexVsSpotBasisPct: basisPct(indexPrice, numericSpotPrice),
      markVsIndexPremiumPct: basisPct(markPrice, indexPrice),
    },
    openInterest: {
      currentUsd: rounded(latestStats?.openInterestUsd),
      changePct: oiChanges,
    },
    funding: {
      latestRate: rounded(latestFunding?.rate),
      latestTimestampMs: latestFunding?.timestampMs || null,
      sampleCount: fundingRows.length,
      mean30: rounded(mean(fundingValues)),
      zScore30: rounded(zScore(latestFunding?.rate, fundingValues)),
      min30: fundingValues.length ? rounded(Math.min(...fundingValues)) : null,
      max30: fundingValues.length ? rounded(Math.max(...fundingValues)) : null,
    },
    positioning,
    liquidations: {
      "1h": liquidationWindow(stats, 60 * 60 * 1_000, now),
      "4h": liquidationWindow(stats, 4 * 60 * 60 * 1_000, now),
      "24h": liquidationWindow(stats, 24 * 60 * 60 * 1_000, now),
    },
    dataQuality: {
      statsInterval: "5m",
      statsSampleCount: stats.length,
      oldestStatsTimestampMs: stats[0]?.timestampMs || null,
      newestStatsTimestampMs: latestStats?.timestampMs || null,
    },
  };
}

const derivativesCache = new Map();
const derivativesInFlight = new Map();

async function cachedDerivativesEvidence(input, dependencies = {}) {
  const pair = normalizedPair(input.pair);
  const now = dependencies.now?.() ?? Date.now();
  const cached = derivativesCache.get(pair);
  if (cached && now - cached.cachedAt < DERIVATIVES_CACHE_MS)
    return { ...cached.value, cacheHit: true };
  if (derivativesInFlight.has(pair)) return derivativesInFlight.get(pair);
  const request = fetchDerivativesEvidence({
    ...input,
    client: dependencies.client || input.client,
    now,
  })
    .then((value) => {
      derivativesCache.set(pair, { cachedAt: now, value });
      return { ...value, cacheHit: false };
    })
    .finally(() => derivativesInFlight.delete(pair));
  derivativesInFlight.set(pair, request);
  return request;
}

const cryptoMarketEvidenceManager = new GateSpotEvidenceCollectorManager();

async function publicMarketSupportingEvidence({
  pair,
  derivativesPair = pair,
  spotPrice = null,
  collectorManager = cryptoMarketEvidenceManager,
  derivativesClient = new GatePublicMarketClient(),
}) {
  const normalized = normalizedPair(pair);
  const normalizedDerivativesPair = derivativesPair
    ? normalizedPair(derivativesPair)
    : null;
  const [spotResult, derivativesResult] = await Promise.allSettled([
    collectorManager.evidence(normalized),
    normalizedDerivativesPair
      ? cachedDerivativesEvidence(
          { pair: normalizedDerivativesPair, spotPrice },
          { client: derivativesClient }
        )
      : Promise.resolve({
          source: "gate_public_usdt_perpetual",
          contract: null,
          status: "unavailable",
          reason: "derivatives_pair_unavailable",
        }),
  ]);
  const spotMicrostructure =
    spotResult.status === "fulfilled"
      ? spotResult.value
      : {
          source: "gate_public_spot",
          pair: normalized,
          status: "unavailable",
          error: spotResult.reason?.code || "provider_unavailable",
        };
  const derivatives =
    derivativesResult.status === "fulfilled"
      ? derivativesResult.value
      : {
          source: "gate_public_usdt_perpetual",
          contract: normalizedDerivativesPair,
          status: "unavailable",
          reason: derivativesResult.reason?.code || "provider_unavailable",
        };
  const statuses = [spotMicrostructure.status, derivatives.status];
  return {
    formulaVersion: EVIDENCE_FORMULA_VERSION,
    status: statuses.every((status) => status === "complete")
      ? "complete"
      : statuses.some((status) => status === "warming")
        ? "warming"
        : statuses.some((status) => ["complete", "partial"].includes(status))
          ? "partial"
          : "unavailable",
    spotMicrostructure,
    derivatives,
  };
}

function clearMarketEvidenceCaches() {
  derivativesCache.clear();
  derivativesInFlight.clear();
}

module.exports = {
  COLLECTOR_IDLE_MS,
  DEPTH_SAMPLE_INTERVAL_MS,
  EVIDENCE_FORMULA_VERSION,
  GateSpotEvidenceCollector,
  GateSpotEvidenceCollectorManager,
  MAX_HOT_PAIRS,
  TRADE_RETENTION_MS,
  WINDOW_MS,
  _internals: {
    depthMetrics,
    depthWindow,
    liquidationWindow,
    normalizeContractStats,
    normalizeTrade,
    tradeWindow,
    zScore,
  },
  cachedDerivativesEvidence,
  clearMarketEvidenceCaches,
  cryptoMarketEvidenceManager,
  fetchDerivativesEvidence,
  publicMarketSupportingEvidence,
};
