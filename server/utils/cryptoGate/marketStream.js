const WebSocket = require("ws");
const { GATE_WS_SPOT_URL } = require("./constants");
const { safeErrorMessage } = require("./sanitizer");
const {
  MAX_CACHED_CANDLES,
  RECENT_FALLBACK_LIMIT,
  applyRealtimeCandle,
  applyRealtimeTrade,
  getMarketCacheSnapshot,
  marketCandleCacheKey,
  refreshRecentMarketCandles,
  resolveMarketRequest,
  setMarketCacheSubscriberCount,
  setMarketCacheWsStatus,
} = require("./marketCandles");

const BROADCAST_THROTTLE_MS = 250;
const FALLBACK_REST_INTERVAL_MS = 2_000;
const IDLE_CLOSE_MS = 60_000;
const STALE_WS_MS = 4_000;
const MAX_RECONNECT_MS = 30_000;

function nowSeconds() {
  return Math.floor(Date.now() / 1_000);
}

function parseMessage(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

function sseWrite(response, event, payload) {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

class GatePublicMarketStream {
  constructor({ marketType, parsedPair, meta, cacheKey }) {
    this.marketType = marketType;
    this.parsedPair = parsedPair;
    this.meta = meta;
    this.cacheKey = cacheKey;
    this.subscribers = new Map();
    this.ws = null;
    this.wsMode = "candlesticks";
    this.status = "idle";
    this.lastError = null;
    this.lastBroadcastAt = 0;
    this.lastBroadcastSnapshotAt = null;
    this.broadcastTimer = null;
    this.fallbackTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.idleCloseTimer = null;
  }

  subscribe(response) {
    const id = `${Date.now()}:${Math.random().toString(16).slice(2)}`;
    this.prepareSseResponse(response);
    this.subscribers.set(id, response);
    this.syncSubscriberCount();
    this.clearIdleCloseTimer();
    this.ensureStarted();
    this.sendSnapshot(response, "snapshot");

    const unsubscribe = () => {
      this.subscribers.delete(id);
      this.syncSubscriberCount();
      if (!this.subscribers.size) this.scheduleIdleClose();
    };
    response.on("close", unsubscribe);
    response.on("error", unsubscribe);
    return unsubscribe;
  }

  prepareSseResponse(response) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders?.();
  }

  ensureStarted() {
    this.startFallbackScheduler();
    if (
      this.ws &&
      [WebSocket.CONNECTING, WebSocket.OPEN].includes(this.ws.readyState)
    ) {
      return;
    }
    this.connect(this.wsMode);
  }

  connect(mode = "candlesticks") {
    this.clearReconnectTimer();
    this.status = "connecting";
    this.wsMode = mode;
    this.lastError = null;
    setMarketCacheWsStatus(this.cacheKey, "connecting");
    this.scheduleBroadcast();

    const ws = new WebSocket(GATE_WS_SPOT_URL);
    this.ws = ws;

    ws.on("open", () => {
      this.status = "connected";
      this.reconnectAttempt = 0;
      setMarketCacheWsStatus(this.cacheKey, "connected");
      this.sendSubscribe();
      this.scheduleBroadcast();
    });

    ws.on("message", (raw) => this.handleWsMessage(raw));

    ws.on("close", (code) => {
      if (this.ws === ws) this.ws = null;
      this.status = "disconnected";
      this.lastError = code === 1_000 ? null : `closed:${code}`;
      setMarketCacheWsStatus(this.cacheKey, "disconnected");
      this.scheduleBroadcast();
      if (this.subscribers.size) this.scheduleReconnect();
    });

    ws.on("error", (error) => {
      this.status = "error";
      this.lastError = safeErrorMessage(error);
      setMarketCacheWsStatus(this.cacheKey, "error");
      this.scheduleBroadcast();
    });
  }

  sendSubscribe() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payload =
      this.wsMode === "trades"
        ? [this.parsedPair.gateCurrencyPair]
        : [this.meta.interval, this.parsedPair.gateCurrencyPair];
    this.ws.send(
      JSON.stringify({
        time: nowSeconds(),
        channel: this.wsMode === "trades" ? "spot.trades" : "spot.candlesticks",
        event: "subscribe",
        payload,
      })
    );
  }

  handleWsMessage(raw) {
    const message = parseMessage(raw);
    if (!message || message.event !== "update") return;

    if (message.channel === "spot.candlesticks") {
      applyRealtimeCandle({
        pair: this.parsedPair.gateCurrencyPair,
        range: this.meta.id,
        market: this.marketType,
        candle: message.result,
      });
      this.scheduleBroadcast();
      return;
    }

    if (message.channel === "spot.trades") {
      const trades = Array.isArray(message.result)
        ? message.result
        : [message.result];
      for (const trade of trades) {
        applyRealtimeTrade({
          pair: this.parsedPair.gateCurrencyPair,
          range: this.meta.id,
          market: this.marketType,
          trade,
        });
      }
      this.scheduleBroadcast();
    }
  }

  scheduleReconnect() {
    this.clearReconnectTimer();
    const delay = Math.min(
      1_000 * 2 ** Math.min(this.reconnectAttempt, 5),
      MAX_RECONNECT_MS
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      if (!this.subscribers.size) return;
      this.connect(this.wsMode);
    }, delay);
  }

  startFallbackScheduler() {
    if (this.fallbackTimer) return;
    this.fallbackTimer = setInterval(() => {
      this.runFallbackRefresh().catch(() => {});
    }, FALLBACK_REST_INTERVAL_MS);
  }

  async runFallbackRefresh() {
    if (!this.subscribers.size) return;
    const snapshot = getMarketCacheSnapshot({
      pair: this.parsedPair.gateCurrencyPair,
      range: this.meta.id,
      market: this.marketType,
    });
    const lastWsMessageAt = Number(snapshot?.lastWsMessageAt || 0);
    if (
      this.status === "connected" &&
      lastWsMessageAt &&
      Date.now() - lastWsMessageAt < STALE_WS_MS
    ) {
      return;
    }

    setMarketCacheWsStatus(this.cacheKey, "fallback");
    await refreshRecentMarketCandles({
      pair: this.parsedPair.gateCurrencyPair,
      range: this.meta.id,
      market: this.marketType,
      limit: RECENT_FALLBACK_LIMIT,
    });
    this.scheduleBroadcast();
  }

  scheduleBroadcast() {
    if (this.broadcastTimer) return;
    const delay = Math.max(
      0,
      BROADCAST_THROTTLE_MS - (Date.now() - this.lastBroadcastAt)
    );
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.broadcast();
    }, delay);
  }

  broadcast() {
    const snapshot = getMarketCacheSnapshot({
      pair: this.parsedPair.gateCurrencyPair,
      range: this.meta.id,
      market: this.marketType,
    });
    const latestSnapshotAt = snapshot?.latestSnapshotAt || null;
    if (
      latestSnapshotAt &&
      latestSnapshotAt === this.lastBroadcastSnapshotAt &&
      this.status === "connected"
    ) {
      return;
    }

    this.lastBroadcastAt = Date.now();
    this.lastBroadcastSnapshotAt = latestSnapshotAt;
    const payload = this.payload(snapshot);
    for (const response of this.subscribers.values()) {
      sseWrite(response, "candles", payload);
    }
  }

  sendSnapshot(response, event = "snapshot") {
    const snapshot = getMarketCacheSnapshot({
      pair: this.parsedPair.gateCurrencyPair,
      range: this.meta.id,
      market: this.marketType,
    });
    sseWrite(response, event, this.payload(snapshot));
  }

  payload(snapshot) {
    return {
      type: "market_candles",
      cacheKey: this.cacheKey,
      marketType: this.marketType,
      gateCurrencyPair: this.parsedPair.gateCurrencyPair,
      range: this.meta.id,
      gateInterval: this.meta.interval,
      candles: Array.isArray(snapshot?.candles)
        ? snapshot.candles.slice(-MAX_CACHED_CANDLES)
        : [],
      latestSnapshotAt: snapshot?.latestSnapshotAt || null,
      lastUpdatedAt: snapshot?.lastUpdatedAt || null,
      wsStatus: snapshot?.wsStatus || this.status,
      restStatus: snapshot?.restStatus || "idle",
      lastRestFetchAt: snapshot?.lastRestFetchAt || null,
      lastWsMessageAt: snapshot?.lastWsMessageAt || null,
      subscriberCount: this.subscribers.size,
      currentPriceQuote: snapshot?.currentPriceQuote || null,
      change24hPct: snapshot?.change24hPct || null,
      lastError: this.lastError,
    };
  }

  syncSubscriberCount() {
    setMarketCacheSubscriberCount(this.cacheKey, this.subscribers.size);
  }

  scheduleIdleClose() {
    this.clearIdleCloseTimer();
    this.idleCloseTimer = setTimeout(() => {
      if (this.subscribers.size) return;
      this.stop();
    }, IDLE_CLOSE_MS);
  }

  clearIdleCloseTimer() {
    if (this.idleCloseTimer) clearTimeout(this.idleCloseTimer);
    this.idleCloseTimer = null;
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  stop() {
    this.clearIdleCloseTimer();
    this.clearReconnectTimer();
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.broadcastTimer = null;
    this.fallbackTimer = null;
    this.status = "idle";
    setMarketCacheWsStatus(this.cacheKey, "idle");
    if (this.ws) {
      try {
        this.ws.close(1_000, "idle");
      } catch {}
      this.ws = null;
    }
  }

  snapshot() {
    return {
      cacheKey: this.cacheKey,
      status: this.status,
      wsMode: this.wsMode,
      subscriberCount: this.subscribers.size,
      reconnectAttempt: this.reconnectAttempt,
      lastError: this.lastError,
    };
  }
}

class GatePublicMarketStreamManager {
  constructor() {
    this.streams = new Map();
  }

  subscribe({ pair, range, market = "spot", response }) {
    const { marketType, parsedPair, meta } = resolveMarketRequest({
      pair,
      range,
      market,
    });
    const cacheKey = marketCandleCacheKey({
      market: marketType,
      pair: parsedPair.gateCurrencyPair,
      range: meta.id,
    });
    let stream = this.streams.get(cacheKey);
    if (!stream) {
      stream = new GatePublicMarketStream({
        marketType,
        parsedPair,
        meta,
        cacheKey,
      });
      this.streams.set(cacheKey, stream);
    }
    return stream.subscribe(response);
  }

  status() {
    return Array.from(this.streams.values()).map((stream) => stream.snapshot());
  }
}

const cryptoGateMarketStreamManager = new GatePublicMarketStreamManager();

module.exports = {
  GatePublicMarketStream,
  GatePublicMarketStreamManager,
  cryptoGateMarketStreamManager,
};
