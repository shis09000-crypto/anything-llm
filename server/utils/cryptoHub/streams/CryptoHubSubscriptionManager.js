class CryptoHubSubscriptionManager {
  constructor({ idleCloseMs = 60_000 } = {}) {
    this.idleCloseMs = idleCloseMs;
    this.topicStates = new Map();
  }

  increment(topic) {
    const state = this.topicStates.get(topic) || {
      subscriberCount: 0,
      idleTimer: null,
    };
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = null;
    state.subscriberCount += 1;
    this.topicStates.set(topic, state);
    return state.subscriberCount;
  }

  decrement(topic, onIdle) {
    const state = this.topicStates.get(topic);
    if (!state) return 0;
    state.subscriberCount = Math.max(0, state.subscriberCount - 1);
    if (state.subscriberCount === 0 && typeof onIdle === "function") {
      state.idleTimer = setTimeout(onIdle, this.idleCloseMs);
    }
    return state.subscriberCount;
  }

  count(topic) {
    return this.topicStates.get(topic)?.subscriberCount || 0;
  }
}

module.exports = {
  CryptoHubSubscriptionManager,
};
