const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");
const { SUPPORTED_SYMBOLS } = require("./constants");

const STREAM_BASE = "wss://stream.binance.com:9443/stream";
const REST_BASE = "https://data-api.binance.vision/api/v3";
const RAW_ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
const RAW_ARCHIVE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEPTH_WINDOWS = Object.freeze([10, 25, 50]);

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(ratio * sorted.length) - 1)
  ];
}

function imbalance(bid, ask) {
  const total = bid + ask;
  return total > 0 ? (bid - ask) / total : null;
}

function emptyMinute(symbol, minuteMs) {
  return {
    symbol,
    minuteMs,
    takerBuyQuote: 0,
    takerSellQuote: 0,
    tradeCount: 0,
    spreadBps: [],
    micropriceOffsetBps: [],
    depthSamples: Object.fromEntries(
      DEPTH_WINDOWS.map((window) => [
        `${window}bps`,
        { bid: [], ask: [], imbalance: [] },
      ])
    ),
    gapCount: 0,
    resyncCount: 0,
    sampleSeconds: new Set(),
    lastBookSampleSecond: null,
  };
}

function applyLevels(levels, updates) {
  for (const [rawPrice, rawQuantity] of updates || []) {
    const price = number(rawPrice);
    const quantity = number(rawQuantity);
    if (!(price > 0) || quantity === null) continue;
    if (quantity === 0) levels.delete(price);
    else levels.set(price, quantity);
  }
}

function depthAt(book, midpoint, windowBps) {
  const ratio = windowBps / 10_000;
  let bid = 0;
  let ask = 0;
  for (const [price, quantity] of book.bids)
    if (price >= midpoint * (1 - ratio) && price <= midpoint)
      bid += price * quantity;
  for (const [price, quantity] of book.asks)
    if (price <= midpoint * (1 + ratio) && price >= midpoint)
      ask += price * quantity;
  return { bid, ask, imbalance: imbalance(bid, ask) };
}

function aggregateMinute(bucket, availableAtMs) {
  const depth = Object.fromEntries(
    DEPTH_WINDOWS.map((window) => {
      const source = bucket.depthSamples[`${window}bps`];
      const average = (values) =>
        values.length
          ? values.reduce((sum, value) => sum + value, 0) / values.length
          : null;
      const bid = average(source.bid);
      const ask = average(source.ask);
      return [
        `${window}bps`,
        {
          bid,
          ask,
          imbalance:
            source.imbalance.length > 0 ? average(source.imbalance) : null,
        },
      ];
    })
  );
  return {
    symbol: bucket.symbol,
    minuteMs: bucket.minuteMs,
    source: "binance",
    takerBuyQuote: bucket.takerBuyQuote,
    takerSellQuote: bucket.takerSellQuote,
    tradeCount: bucket.tradeCount,
    cumulativeVolumeDelta: bucket.takerBuyQuote - bucket.takerSellQuote,
    tradeVelocity: bucket.tradeCount / 60,
    spreadBpsMean: bucket.spreadBps.length
      ? bucket.spreadBps.reduce((sum, value) => sum + value, 0) /
        bucket.spreadBps.length
      : null,
    spreadBpsP95: percentile(bucket.spreadBps, 0.95),
    micropriceOffsetBpsMean: bucket.micropriceOffsetBps.length
      ? bucket.micropriceOffsetBps.reduce((sum, value) => sum + value, 0) /
        bucket.micropriceOffsetBps.length
      : null,
    depth,
    gapCount: bucket.gapCount,
    resyncCount: bucket.resyncCount,
    samplingCoverage: bucket.sampleSeconds.size / 60,
    availableAtMs,
  };
}

class AnomalyArchive {
  constructor({
    root,
    now = () => Date.now(),
    maxBytes = RAW_ARCHIVE_MAX_BYTES,
    retentionMs = RAW_ARCHIVE_RETENTION_MS,
  }) {
    this.root = path.join(root, "anomalies");
    this.now = now;
    this.maxBytes = maxBytes;
    this.retentionMs = retentionMs;
    fs.mkdirSync(this.root, { recursive: true });
  }

  files() {
    return fs
      .readdirSync(this.root)
      .map((name) => {
        const file = path.join(this.root, name);
        const stat = fs.statSync(file);
        return { file, name, bytes: stat.size, mtimeMs: stat.mtimeMs };
      })
      .filter((entry) => entry.name.endsWith(".jsonl"))
      .sort((left, right) => left.mtimeMs - right.mtimeMs);
  }

  prune() {
    const cutoff = this.now() - this.retentionMs;
    let files = this.files();
    for (const entry of files)
      if (entry.mtimeMs < cutoff) fs.unlinkSync(entry.file);
    files = this.files();
    let bytes = files.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of files) {
      if (bytes <= this.maxBytes) break;
      fs.unlinkSync(entry.file);
      bytes -= entry.bytes;
    }
    return bytes;
  }

  record(symbol, reason, payload) {
    const minute = Math.floor(this.now() / 60_000) * 60_000;
    const file = path.join(this.root, `${symbol}-${minute}.jsonl`);
    fs.appendFileSync(
      file,
      `${JSON.stringify({
        observedAtMs: this.now(),
        symbol,
        reason,
        payload,
      })}\n`,
      { mode: 0o600 }
    );
    return this.prune();
  }
}

class BinanceMicrostructureCollector {
  constructor({
    store,
    root,
    symbols = SUPPORTED_SYMBOLS,
    now = () => Date.now(),
    fetchImpl = global.fetch,
    WebSocketImpl = WebSocket,
    archive = null,
    onMetric = () => {},
  }) {
    this.store = store;
    this.root = root;
    this.symbols = symbols;
    this.now = now;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.archive = archive || new AnomalyArchive({ root, now });
    this.onMetric = onMetric;
    this.running = false;
    this.socket = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.startedAtMs = null;
    this.states = new Map(
      symbols.map((symbol) => [
        symbol,
        {
          book: {
            bids: new Map(),
            asks: new Map(),
            lastUpdateId: null,
            synchronized: false,
            syncing: false,
            buffered: [],
          },
          bucket: emptyMinute(symbol, Math.floor(now() / 60_000) * 60_000),
          lastEventAtMs: null,
        },
      ])
    );
  }

  streamUrl() {
    const streams = this.symbols.flatMap((symbol) => {
      const pair = `${symbol.toLowerCase()}usdt`;
      return [`${pair}@aggTrade`, `${pair}@bookTicker`, `${pair}@depth@100ms`];
    });
    return `${STREAM_BASE}?streams=${streams.join("/")}`;
  }

  start() {
    if (this.running) return this.snapshot();
    this.running = true;
    this.startedAtMs = this.now();
    this.connect();
    return this.snapshot();
  }

  connect() {
    if (!this.running || this.socket) return;
    const socket = new this.WebSocketImpl(this.streamUrl());
    this.socket = socket;
    socket.on("open", () => {
      this.reconnectAttempt = 0;
      for (const symbol of this.symbols) void this.resync(symbol, "startup");
    });
    socket.on("message", (value) => this.handleMessage(value));
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      if (!this.running) return;
      this.reconnectAttempt += 1;
      const delay = Math.min(
        30_000,
        1_000 * 2 ** Math.min(5, this.reconnectAttempt)
      );
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
      this.reconnectTimer.unref?.();
    });
  }

  handleMessage(raw) {
    let envelope;
    try {
      envelope = JSON.parse(String(raw));
    } catch {
      return;
    }
    const data = envelope?.data || envelope;
    const symbol = String(data?.s || "")
      .replace(/USDT$/, "")
      .toUpperCase();
    if (!this.states.has(symbol)) return;
    const observedAtMs = this.now();
    const state = this.states.get(symbol);
    state.lastEventAtMs = observedAtMs;
    this.rollMinute(state, observedAtMs);
    if (data.e === "aggTrade") this.handleTrade(state, data, observedAtMs);
    else if (data.e === "depthUpdate")
      this.handleDepth(state, data, observedAtMs);
    else if (data.b && data.a) this.sampleBook(state, data, observedAtMs);
  }

  rollMinute(state, observedAtMs) {
    const minute = Math.floor(observedAtMs / 60_000) * 60_000;
    if (state.bucket.minuteMs === minute) return;
    if (state.bucket.minuteMs < minute)
      this.store.upsertMicrostructureMinute(
        aggregateMinute(state.bucket, observedAtMs)
      );
    state.bucket = emptyMinute(state.bucket.symbol, minute);
  }

  handleTrade(state, data, observedAtMs) {
    const price = number(data.p);
    const quantity = number(data.q);
    if (!(price > 0) || !(quantity >= 0)) return;
    const quote = price * quantity;
    if (data.m === true) state.bucket.takerSellQuote += quote;
    else state.bucket.takerBuyQuote += quote;
    state.bucket.tradeCount += 1;
    state.bucket.sampleSeconds.add(Math.floor(observedAtMs / 1_000));
  }

  handleDepth(state, data, observedAtMs) {
    const book = state.book;
    if (!book.synchronized) {
      book.buffered.push(data);
      if (book.buffered.length > 1_000) book.buffered.shift();
      if (!book.syncing)
        void this.resync(state.bucket.symbol, "unsynchronized");
      return;
    }
    if (Number(data.u) <= book.lastUpdateId) return;
    if (Number(data.U) > book.lastUpdateId + 1) {
      state.bucket.gapCount += 1;
      this.onMetric("gap", state.bucket.symbol, 1);
      this.archive.record(state.bucket.symbol, "depth_sequence_gap", {
        expected: book.lastUpdateId + 1,
        first: Number(data.U),
        final: Number(data.u),
      });
      book.synchronized = false;
      book.buffered = [data];
      void this.resync(state.bucket.symbol, "sequence_gap");
      return;
    }
    applyLevels(book.bids, data.b);
    applyLevels(book.asks, data.a);
    book.lastUpdateId = Number(data.u);
    state.bucket.sampleSeconds.add(Math.floor(observedAtMs / 1_000));
  }

  sampleBook(state, ticker, observedAtMs) {
    const second = Math.floor(observedAtMs / 1_000);
    if (state.bucket.lastBookSampleSecond === second) return;
    state.bucket.lastBookSampleSecond = second;
    const bid = number(ticker.b);
    const ask = number(ticker.a);
    const bidQuantity = number(ticker.B);
    const askQuantity = number(ticker.A);
    if (!(bid > 0) || !(ask > bid)) return;
    const midpoint = (bid + ask) / 2;
    const spreadBps = ((ask - bid) / midpoint) * 10_000;
    const microprice =
      bidQuantity !== null &&
      askQuantity !== null &&
      bidQuantity + askQuantity > 0
        ? (ask * bidQuantity + bid * askQuantity) / (bidQuantity + askQuantity)
        : midpoint;
    state.bucket.spreadBps.push(spreadBps);
    state.bucket.micropriceOffsetBps.push(
      ((microprice - midpoint) / midpoint) * 10_000
    );
    if (spreadBps > 100)
      this.archive.record(state.bucket.symbol, "abnormal_spread", {
        bid,
        ask,
        spreadBps,
      });
    if (state.book.synchronized)
      for (const window of DEPTH_WINDOWS) {
        const value = depthAt(state.book, midpoint, window);
        const target = state.bucket.depthSamples[`${window}bps`];
        target.bid.push(value.bid);
        target.ask.push(value.ask);
        if (value.imbalance !== null) target.imbalance.push(value.imbalance);
      }
    state.bucket.sampleSeconds.add(second);
  }

  async resync(symbol, reason) {
    const state = this.states.get(symbol);
    if (!state || state.book.syncing || !this.running) return;
    state.book.syncing = true;
    try {
      const response = await this.fetchImpl(
        `${REST_BASE}/depth?symbol=${encodeURIComponent(`${symbol}USDT`)}&limit=1000`,
        { headers: { Accept: "application/json" } }
      );
      if (!response.ok)
        throw new Error(`depth_snapshot_http_${response.status}`);
      const snapshot = await response.json();
      const lastUpdateId = Number(snapshot.lastUpdateId);
      if (!Number.isSafeInteger(lastUpdateId))
        throw new Error("depth_snapshot_invalid");
      state.book.bids = new Map();
      state.book.asks = new Map();
      applyLevels(state.book.bids, snapshot.bids);
      applyLevels(state.book.asks, snapshot.asks);
      state.book.lastUpdateId = lastUpdateId;
      const buffered = state.book.buffered
        .filter((event) => Number(event.u) > lastUpdateId)
        .sort((left, right) => Number(left.U) - Number(right.U));
      state.book.buffered = [];
      state.book.synchronized = true;
      for (const event of buffered) {
        if (!state.book.synchronized) break;
        this.handleDepth(state, event, this.now());
      }
      state.bucket.resyncCount += 1;
      this.onMetric("resync", symbol, 1);
      if (reason !== "startup")
        this.archive.record(symbol, "depth_resynchronized", {
          reason,
          lastUpdateId,
        });
    } catch {
      state.book.synchronized = false;
      this.onMetric("resync_failure", symbol, 1);
    } finally {
      state.book.syncing = false;
    }
  }

  snapshot() {
    const now = this.now();
    return {
      running: this.running,
      source: "binance",
      startedAtMs: this.startedAtMs,
      status:
        this.running &&
        this.startedAtMs &&
        now - this.startedAtMs >= 15 * 60_000
          ? "collecting"
          : this.running
            ? "warming"
            : "stopped",
      symbols: Object.fromEntries(
        [...this.states].map(([symbol, state]) => [
          symbol,
          {
            synchronized: state.book.synchronized,
            lastUpdateId: state.book.lastUpdateId,
            lastEventAtMs: state.lastEventAtMs,
            freshnessMs: state.lastEventAtMs
              ? Math.max(0, now - state.lastEventAtMs)
              : null,
            gapCount: state.bucket.gapCount,
            resyncCount: state.bucket.resyncCount,
            samplingCoverage: state.bucket.sampleSeconds.size / 60,
          },
        ])
      ),
      anomalyArchiveBytes: this.archive.prune(),
    };
  }

  stop() {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.on?.("error", () => {});
      if (this.socket.readyState === 0 && this.socket.terminate)
        this.socket.terminate();
      else this.socket.close();
    }
    this.socket = null;
    const stoppedAtMs = this.now();
    for (const state of this.states.values()) {
      if (state.bucket.sampleSeconds.size === 0) continue;
      this.store.upsertMicrostructureMinute(
        aggregateMinute(state.bucket, stoppedAtMs)
      );
    }
    return this.snapshot();
  }
}

module.exports = {
  AnomalyArchive,
  BinanceMicrostructureCollector,
  _internals: {
    aggregateMinute,
    applyLevels,
    depthAt,
    emptyMinute,
    imbalance,
    percentile,
  },
};
