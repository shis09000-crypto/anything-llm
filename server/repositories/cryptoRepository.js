const {
  getGateConfigStatus,
  cryptoGateEventBuffer,
} = require("../utils/cryptoGate");
const { cryptoDataHub } = require("../utils/cryptoHub");
const { sanitizeValue } = require("../utils/dataAccess/dataAccessPolicy");

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
    return safeCall(() => getGateConfigStatus(), {
      enabled: false,
      hasApiKey: false,
      hasApiSecret: false,
    });
  },

  hubStatus() {
    return safeCall(() => cryptoDataHub.getStatus(), {
      status: "unavailable",
      connectionStatus: "disconnected",
    });
  },

  loadingProgress() {
    return safeCall(() => cryptoDataHub.getLoadingProgress(), {
      status: "unavailable",
      progress: 0,
    });
  },

  recentEvents({ limit = 100 } = {}) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    return cryptoGateEventBuffer
      .recent(boundedLimit)
      .map((event) => sanitizeValue(event));
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
