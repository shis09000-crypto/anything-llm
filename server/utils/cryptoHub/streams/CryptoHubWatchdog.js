const { safeErrorMessage } = require("../../cryptoGate");

const DEFAULT_THRESHOLD_MS = 5_000;
const DEFAULT_COOLDOWN_MS = 10_000;
const DEFAULT_INTERVAL_MS = 1_000;

function now() {
  return Date.now();
}

class CryptoHubWatchdog {
  constructor({
    thresholdMs = DEFAULT_THRESHOLD_MS,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    intervalMs = DEFAULT_INTERVAL_MS,
    autoStart = true,
  } = {}) {
    this.thresholdMs = thresholdMs;
    this.cooldownMs = cooldownMs;
    this.intervalMs = intervalMs;
    this.autoStart = autoStart;
    this.topicStates = new Map();
    this.streams = new Map();
    this.timer = null;
  }

  ensureTopic(topic) {
    if (!this.topicStates.has(topic)) {
      this.topicStates.set(topic, {
        subscriberCount: 0,
        lastPayloadAt: null,
        lastErrorAt: null,
        disconnectedSince: null,
        lastRecoveryAt: null,
        recoveryCount: 0,
        safeErrorMessage: null,
      });
    }
    return this.topicStates.get(topic);
  }

  registerStream(topic, { recover } = {}) {
    const id = `${topic}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    this.ensureTopic(topic);
    this.streams.set(id, {
      id,
      topic,
      recover,
      disconnectedSince: null,
      lastRecoveryAt: null,
      recoveryCount: 0,
      recovering: false,
      safeErrorMessage: null,
    });
    if (this.autoStart) this.start();
    return id;
  }

  unregisterStream(id) {
    this.streams.delete(id);
    if (!this.streams.size) this.stop();
  }

  updateSubscriberCount(topic, subscriberCount) {
    const state = this.ensureTopic(topic);
    state.subscriberCount = Math.max(0, Number(subscriberCount) || 0);
    if (state.subscriberCount === 0) {
      state.disconnectedSince = null;
      state.safeErrorMessage = null;
    }
  }

  recordPayload(topic, streamId = null) {
    const state = this.ensureTopic(topic);
    state.lastPayloadAt = now();
    state.disconnectedSince = null;
    state.safeErrorMessage = null;

    if (streamId && this.streams.has(streamId)) {
      const stream = this.streams.get(streamId);
      stream.disconnectedSince = null;
      stream.recovering = false;
      stream.safeErrorMessage = null;
    }
  }

  recordDisconnect(topic, streamId = null, error = null) {
    const state = this.ensureTopic(topic);
    const timestamp = now();
    state.lastErrorAt = timestamp;
    state.disconnectedSince = state.disconnectedSince || timestamp;
    state.safeErrorMessage = error ? safeErrorMessage(error) : null;

    if (streamId && this.streams.has(streamId)) {
      const stream = this.streams.get(streamId);
      stream.disconnectedSince = stream.disconnectedSince || timestamp;
      stream.safeErrorMessage = state.safeErrorMessage;
    }
  }

  checkNow() {
    const timestamp = now();
    for (const stream of this.streams.values()) {
      const topic = this.ensureTopic(stream.topic);
      if (topic.subscriberCount <= 0 || !stream.disconnectedSince) continue;
      if (stream.recovering || typeof stream.recover !== "function") continue;
      if (timestamp - stream.disconnectedSince < this.thresholdMs) continue;
      if (
        stream.lastRecoveryAt &&
        timestamp - stream.lastRecoveryAt < this.cooldownMs
      ) {
        continue;
      }

      stream.recovering = true;
      stream.lastRecoveryAt = timestamp;
      stream.recoveryCount += 1;
      topic.lastRecoveryAt = timestamp;
      topic.recoveryCount += 1;

      Promise.resolve()
        .then(() => stream.recover())
        .then(() => {
          stream.recovering = false;
        })
        .catch((error) => {
          stream.recovering = false;
          this.recordDisconnect(stream.topic, stream.id, error);
        });
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkNow(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  topicStatus(topic) {
    const streams = Array.from(this.streams.values()).filter(
      (stream) => stream.topic === topic
    );
    const state = this.ensureTopic(topic);
    if (state.subscriberCount <= 0) return "idle";
    if (streams.some((stream) => stream.recovering)) return "recovering";
    if (streams.some((stream) => stream.disconnectedSince))
      return "disconnected";
    return "connected";
  }

  snapshot() {
    const topics = {};
    for (const [topic, state] of this.topicStates.entries()) {
      topics[topic] = {
        subscriberCount: state.subscriberCount,
        status: this.topicStatus(topic),
        lastPayloadAt: state.lastPayloadAt,
        disconnectedSince: state.disconnectedSince,
        lastRecoveryAt: state.lastRecoveryAt,
        recoveryCount: state.recoveryCount,
        safeErrorMessage: state.safeErrorMessage,
      };
    }

    return {
      enabled: true,
      thresholdMs: this.thresholdMs,
      cooldownMs: this.cooldownMs,
      topics,
    };
  }
}

module.exports = {
  CryptoHubWatchdog,
};
