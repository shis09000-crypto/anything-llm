const WebSocket = require("ws");
const {
  DEFAULT_SPOT_PAIR,
  GATE_WS_FUTURES_USDT_URL,
  GATE_WS_SPOT_URL,
} = require("./constants");
const { cryptoGateEventBuffer } = require("./eventBuffer");
const { sanitizePayload, safeErrorMessage } = require("./sanitizer");
const { signWsRequest } = require("./signer");

const MAX_RECONNECT_MS = 60_000;
const PING_INTERVAL_MS = 25_000;

function nowSeconds() {
  return Math.floor(Date.now() / 1_000);
}

function classifyChannel(channel = "") {
  if (channel.includes("balance")) return "balance";
  if (channel.includes("position")) return "position";
  if (channel.includes("order")) return "order";
  if (channel.includes("trade")) return "trade";
  if (channel.includes("ping") || channel.includes("pong")) return "heartbeat";
  return "message";
}

function privateSubscribePayload({ channel, payload, apiKey, apiSecret }) {
  const event = "subscribe";
  const time = nowSeconds();
  return {
    time,
    channel,
    event,
    payload,
    auth: {
      method: "api_key",
      KEY: apiKey,
      SIGN: signWsRequest({
        channel,
        event,
        time,
        secret: apiSecret,
      }),
    },
  };
}

class GateWsConnection {
  constructor({
    source,
    url,
    channels,
    eventBuffer = cryptoGateEventBuffer,
    onPrivateEvent = null,
  }) {
    this.source = source;
    this.url = url;
    this.channels = channels;
    this.eventBuffer = eventBuffer;
    this.ws = null;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.shouldReconnect = false;
    this.status = "idle";
    this.lastConnectedAt = null;
    this.lastEventAt = null;
    this.lastError = null;
    this.credentials = null;
    this.onPrivateEvent = onPrivateEvent;
  }

  start(credentials) {
    this.credentials = credentials;
    this.shouldReconnect = true;
    if (this.status === "connected" || this.status === "connecting") return;
    this.connect();
  }

  stop() {
    this.shouldReconnect = false;
    this.clearTimers();
    this.status = "idle";
    if (this.ws) {
      try {
        this.ws.close(1_000, "stopped");
      } catch {}
      this.ws = null;
    }
  }

  connect() {
    this.clearTimers();
    this.status = "connecting";
    this.lastError = null;

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on("open", () => {
      this.status = "connected";
      this.reconnectAttempt = 0;
      this.lastConnectedAt = Date.now();
      this.pushConnectionEvent("connected");
      this.subscribePrivateChannels();
      this.startPing();
    });

    ws.on("message", (raw) => {
      this.lastEventAt = Date.now();
      const payload = this.parseMessage(raw);
      const eventType = classifyChannel(payload?.channel);
      this.eventBuffer.push({
        source: this.source,
        eventType,
        channel: payload?.channel || "unknown",
        payload,
      });
      if (
        this.onPrivateEvent &&
        ["balance", "position", "order", "trade"].includes(eventType)
      ) {
        this.onPrivateEvent({ source: this.source, eventType, payload });
      }
    });

    ws.on("close", (code, reason) => {
      this.clearTimers();
      this.ws = null;
      if (this.status !== "idle") this.status = "disconnected";
      this.lastError = code === 1_000 ? null : `closed:${code}`;
      this.pushConnectionEvent("closed", {
        code,
        reason: reason?.toString?.() || "",
      });
      this.scheduleReconnect();
    });

    ws.on("error", (error) => {
      this.lastError = safeErrorMessage(error);
      this.status = "error";
      this.pushConnectionEvent("error", { error: this.lastError });
    });
  }

  subscribePrivateChannels() {
    if (!this.credentials?.apiKey || !this.credentials?.apiSecret) return;
    for (const subscription of this.channels) {
      this.send(
        privateSubscribePayload({
          channel: subscription.channel,
          payload: subscription.payload,
          apiKey: this.credentials.apiKey,
          apiSecret: this.credentials.apiSecret,
        })
      );
    }
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  parseMessage(raw) {
    try {
      return JSON.parse(raw.toString());
    } catch {
      return { raw: raw.toString() };
    }
  }

  startPing() {
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        this.ws.ping();
      } catch (error) {
        this.lastError = safeErrorMessage(error);
      }
    }, PING_INTERVAL_MS);
  }

  clearTimers() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
  }

  scheduleReconnect() {
    if (!this.shouldReconnect) return;
    const delay = Math.min(
      1_000 * 2 ** Math.min(this.reconnectAttempt, 6),
      MAX_RECONNECT_MS
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  pushConnectionEvent(status, details = {}) {
    this.eventBuffer.push({
      source: this.source,
      eventType: "connection",
      channel: "connection",
      payload: sanitizePayload({
        status,
        details,
      }),
    });
  }

  snapshot() {
    return {
      source: this.source,
      status: this.status,
      lastConnectedAt: this.lastConnectedAt,
      lastEventAt: this.lastEventAt,
      reconnectAttempt: this.reconnectAttempt,
      lastError: this.lastError,
      channels: this.channels.map(({ channel }) => channel),
    };
  }
}

class GateWsManager {
  constructor({ eventBuffer = cryptoGateEventBuffer } = {}) {
    const spotPair = process.env.GATE_PROBE_SPOT_PAIR || DEFAULT_SPOT_PAIR;
    this.eventBuffer = eventBuffer;
    this.onPrivateEvent = null;
    this.privateEventListeners = new Set();
    this.spot = new GateWsConnection({
      source: "spot",
      url: GATE_WS_SPOT_URL,
      eventBuffer,
      onPrivateEvent: (event) => this.handlePrivateEvent(event),
      channels: [
        { channel: "spot.balances", payload: [] },
        { channel: "spot.orders", payload: [spotPair] },
        { channel: "spot.usertrades", payload: [spotPair] },
        { channel: "spot.funding_balances", payload: [] },
      ],
    });
    this.futures = new GateWsConnection({
      source: "futures_usdt",
      url: GATE_WS_FUTURES_USDT_URL,
      eventBuffer,
      onPrivateEvent: (event) => this.handlePrivateEvent(event),
      channels: [
        { channel: "futures.balances", payload: ["usdt"] },
        { channel: "futures.positions", payload: ["usdt"] },
        { channel: "futures.orders", payload: ["usdt"] },
        { channel: "futures.usertrades", payload: ["usdt"] },
      ],
    });
  }

  setEventHandler(handler) {
    this.onPrivateEvent = handler;
  }

  addPrivateEventListener(listener) {
    if (typeof listener !== "function") return () => {};
    this.privateEventListeners.add(listener);
    return () => this.privateEventListeners.delete(listener);
  }

  handlePrivateEvent(event) {
    if (this.onPrivateEvent) this.onPrivateEvent(event);
    for (const listener of this.privateEventListeners) {
      try {
        listener(event);
      } catch (error) {
        this.eventBuffer.push({
          source: event?.source || "private_ws",
          eventType: "listener_error",
          channel: event?.payload?.channel || "private.listener",
          payload: {
            error: error?.message || "Gate private listener failed",
          },
        });
      }
    }
  }

  start(credentials) {
    this.spot.start(credentials);
    this.futures.start(credentials);
    return this.status();
  }

  stop() {
    this.spot.stop();
    this.futures.stop();
    return this.status();
  }

  status() {
    return {
      spot: this.spot.snapshot(),
      futuresUsdt: this.futures.snapshot(),
    };
  }
}

const cryptoGateWsManager = new GateWsManager();

module.exports = {
  GateWsConnection,
  GateWsManager,
  cryptoGateWsManager,
};
