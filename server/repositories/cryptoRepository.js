const { CryptoRuntime } = require("../modules/crypto");

function safeCall(fn, fallback) {
  try {
    return fn();
  } catch (error) {
    return {
      ...fallback,
      error: error?.message || String(error),
      code: error?.code || null,
    };
  }
}

const CryptoRepository = {
  dataDomain: "crypto",
  repositoryName: "CryptoRepository",

  configStatus() {
    return safeCall(() => CryptoRuntime.config.status(), {
      enabled: false,
      hasApiKey: false,
      hasApiSecret: false,
    });
  },

  hubStatus() {
    return safeCall(() => CryptoRuntime.hub.status(), {
      status: "unavailable",
      connectionStatus: "disconnected",
    });
  },

  loadingProgress() {
    return safeCall(() => CryptoRuntime.hub.loadingProgress(), {
      status: "unavailable",
      progress: 0,
    });
  },

  recentEvents({ limit = 100 } = {}) {
    return CryptoRuntime.gate.recentEvents({ limit });
  },

  snapshot() {
    return {
      config: this.configStatus(),
      hub: this.hubStatus(),
      loading: this.loadingProgress(),
      recentEvents: this.recentEvents({ limit: 25 }),
    };
  },
};

module.exports = { CryptoRepository };
