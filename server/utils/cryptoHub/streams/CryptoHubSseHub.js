const { EventEmitter } = require("events");
const { safeErrorMessage } = require("../../cryptoGate");
const { CryptoHubWatchdog } = require("./CryptoHubWatchdog");

const HEARTBEAT_MS = 25_000;

function writeSse(response, event, payload) {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function parseSseBlock(block) {
  const lines = String(block || "").split(/\r?\n/);
  const eventLine = lines.find((line) => line.startsWith("event:"));
  const dataLines = lines.filter((line) => line.startsWith("data:"));
  const event = eventLine ? eventLine.replace(/^event:\s*/, "").trim() : "";
  const data = dataLines
    .map((line) => line.replace(/^data:\s*/, ""))
    .join("\n")
    .trim();
  if (!data) return null;
  try {
    return {
      event: event || "message",
      data: JSON.parse(data),
    };
  } catch {
    return null;
  }
}

function hubEventType(legacyEvent) {
  if (legacyEvent === "snapshot") return "snapshot";
  if (legacyEvent === "error") return "error";
  if (legacyEvent === "status") return "status";
  if (legacyEvent === "heartbeat") return "heartbeat";
  return "update";
}

class LegacySseProxyResponse extends EventEmitter {
  constructor({ topic, response, sseHub, streamId }) {
    super();
    this.topic = topic;
    this.response = response;
    this.sseHub = sseHub;
    this.streamId = streamId;
    this.buffer = "";
  }

  get destroyed() {
    return this.response.destroyed;
  }

  get writableEnded() {
    return this.response.writableEnded;
  }

  writeHead() {}

  flushHeaders() {}

  write(chunk) {
    this.buffer += chunk?.toString?.() || String(chunk || "");
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const parsed = parseSseBlock(block);
      if (parsed) {
        this.sseHub.publish(this.topic, parsed.data, {
          type: hubEventType(parsed.event),
          streamId: this.streamId,
        });
      }
      boundary = this.buffer.indexOf("\n\n");
    }
    return true;
  }

  end() {
    if (!this.response.writableEnded) this.emit("close");
  }
}

class CryptoHubSseHub {
  constructor({ heartbeatMs = HEARTBEAT_MS, watchdog = null } = {}) {
    this.heartbeatMs = heartbeatMs;
    this.watchdog = watchdog || new CryptoHubWatchdog();
    this.subscribers = new Map();
    this.heartbeatTimer = null;
  }

  prepare(response) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders?.();
  }

  subscribe(topic, response) {
    this.prepare(response);
    const id = `${topic}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    this.subscribers.set(id, { topic, response });
    this.ensureHeartbeat();
    this.watchdog.updateSubscriberCount(topic, this.subscriberCount(topic));
    const unsubscribe = () => {
      this.subscribers.delete(id);
      this.watchdog.updateSubscriberCount(topic, this.subscriberCount(topic));
      if (!this.subscribers.size) this.stopHeartbeat();
    };
    response.on("close", unsubscribe);
    response.on("error", unsubscribe);
    writeSse(response, "status", {
      type: "status",
      topic,
      asOf: Date.now(),
      data: {
        subscriberCount: this.subscriberCount(topic),
      },
      freshness: null,
      safeErrorMessage: null,
    });
    return unsubscribe;
  }

  publish(
    topic,
    data = {},
    { type = "update", freshness = null, streamId = null } = {}
  ) {
    if (type === "snapshot" || type === "update") {
      this.watchdog.recordPayload(topic, streamId);
    }
    const payload = {
      type,
      topic,
      asOf: Date.now(),
      data,
      freshness,
      safeErrorMessage: data?.safeErrorMessage || null,
    };
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.topic !== topic) continue;
      writeSse(subscriber.response, type, payload);
    }
  }

  publishError(topic, error, options = {}) {
    this.watchdog.recordDisconnect(topic, options.streamId || null, error);
    this.publish(
      topic,
      {
        success: false,
        safeErrorMessage: safeErrorMessage(error),
      },
      { type: "error", streamId: options.streamId || null }
    );
  }

  subscriberCount(topic = null) {
    if (!topic) return this.subscribers.size;
    return Array.from(this.subscribers.values()).filter(
      (subscriber) => subscriber.topic === topic
    ).length;
  }

  async proxyLegacyStream({ topic, response, subscribe }) {
    const unsubscribeHub = this.subscribe(topic, response);
    let active = true;
    let unsubscribeLegacy = null;
    let proxy = null;
    const streamId = this.watchdog.registerStream(topic, {
      recover: async () => startLegacySubscription(),
    });

    const cleanupLegacy = () => {
      const currentProxy = proxy;
      proxy = null;
      if (typeof unsubscribeLegacy === "function") unsubscribeLegacy();
      unsubscribeLegacy = null;
      currentProxy?.emit("close");
      currentProxy?.removeAllListeners("close");
    };

    const startLegacySubscription = async () => {
      if (!active || response.destroyed || response.writableEnded) return;
      cleanupLegacy();
      const nextProxy = new LegacySseProxyResponse({
        topic,
        response,
        sseHub: this,
        streamId,
      });
      proxy = nextProxy;
      nextProxy.on("close", () => {
        if (!active || proxy !== nextProxy) return;
        this.watchdog.recordDisconnect(
          topic,
          streamId,
          "Crypto Hub upstream stream closed"
        );
      });

      try {
        unsubscribeLegacy = await subscribe(nextProxy);
      } catch (error) {
        this.publishError(topic, error, { streamId });
      }
    };

    const cleanup = () => {
      if (!active) return;
      active = false;
      cleanupLegacy();
      this.watchdog.unregisterStream(streamId);
      unsubscribeHub();
    };
    response.on("close", cleanup);
    response.on("error", cleanup);
    await startLegacySubscription();
    return cleanup;
  }

  ensureHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const subscriber of this.subscribers.values()) {
        writeSse(subscriber.response, "heartbeat", {
          type: "heartbeat",
          topic: subscriber.topic,
          asOf: Date.now(),
          data: null,
          freshness: null,
          safeErrorMessage: null,
        });
      }
    }, this.heartbeatMs);
  }

  stopHeartbeat() {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  watchdogSnapshot() {
    return this.watchdog.snapshot();
  }
}

module.exports = {
  CryptoHubSseHub,
  LegacySseProxyResponse,
};
