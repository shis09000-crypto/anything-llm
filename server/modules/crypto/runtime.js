const {
  cryptoCenterSnapshot,
  cryptoCenterDelta,
} = require("../../utils/cryptoCenter/mockSnapshot");
const cryptoGate = require("../../utils/cryptoGate");
const cryptoHub = require("../../utils/cryptoHub");
const {
  backgroundRuntimeEnabled,
  configuredForBackground,
  startCryptoHubBackgroundRuntime,
} = require("../../utils/cryptoHub/backgroundRuntime");
const { sanitizeValue } = require("../../utils/dataAccess/dataAccessPolicy");
const {
  cryptoForecastingRuntime,
  enabled: cryptoForecastingEnabled,
} = require("../../utils/cryptoForecasting");

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

function safeConfigStatus() {
  return safeCall(() => cryptoGate.getGateConfigStatus(), {
    enabled: false,
    env: process.env.GATE_API_ENV || "production",
    readOnly: process.env.GATE_API_READONLY === "true",
    hasApiKey: false,
    hasApiSecret: false,
    maskedApiKey: null,
  });
}

const CryptoRuntime = {
  center: {
    snapshot(range = "24h") {
      return cryptoCenterSnapshot(range);
    },
    delta(snapshot, tick) {
      return cryptoCenterDelta(snapshot, tick);
    },
  },

  hub: {
    dataHub: cryptoHub.cryptoDataHub,
    status() {
      return safeCall(() => cryptoHub.cryptoDataHub.getStatus(), {
        status: "unavailable",
        connectionStatus: "disconnected",
      });
    },
    loadingProgress() {
      return safeCall(() => cryptoHub.cryptoDataHub.getLoadingProgress(), {
        status: "unavailable",
        progress: 0,
      });
    },
    start() {
      return cryptoHub.cryptoDataHub.start();
    },
    stopIfIdle() {
      return cryptoHub.cryptoDataHub.stopIfIdle();
    },
    stopBackgroundRefresh() {
      return cryptoHub.cryptoDataHub.stopBackgroundRefresh();
    },
  },

  gate: {
    eventBuffer: cryptoGate.cryptoGateEventBuffer,
    marketStreamManager: cryptoGate.cryptoGateMarketStreamManager,
    wsManager: cryptoGate.cryptoGateWsManager,
    restClient: cryptoGate.GateRestClient,
    credentials: cryptoGate.getGateCredentials,
    configStatus: safeConfigStatus,
    safeErrorMessage: cryptoGate.safeErrorMessage,
    recentEvents({ limit = 100 } = {}) {
      const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
      return cryptoGate.cryptoGateEventBuffer
        .recent(boundedLimit)
        .map((event) => sanitizeValue(event));
    },
  },

  config: {
    status: safeConfigStatus,
  },

  streams: {
    hub: cryptoHub,
    gate: cryptoGate,
  },

  forecasting: {
    enabled: cryptoForecastingEnabled,
    start() {
      return cryptoForecastingRuntime.start();
    },
    stop() {
      return cryptoForecastingRuntime.stop();
    },
    latest(symbol) {
      return cryptoForecastingRuntime.latest(symbol);
    },
    latestForecasting(symbol) {
      return cryptoForecastingRuntime.latestForecasting(symbol);
    },
    microstructureEvidence(symbol) {
      return cryptoForecastingRuntime.microstructureEvidence(symbol);
    },
    predictions(query) {
      return cryptoForecastingRuntime.predictions(query);
    },
    predictionDetails(predictionId) {
      return cryptoForecastingRuntime.predictionDetails(predictionId);
    },
    governance() {
      return cryptoForecastingRuntime.governance();
    },
    snapshot() {
      return cryptoForecastingRuntime.snapshot();
    },
  },

  diagnostics: {
    snapshot() {
      return {
        config: safeConfigStatus(),
        hub: CryptoRuntime.hub.status(),
        loading: CryptoRuntime.hub.loadingProgress(),
        recentEvents: CryptoRuntime.gate.recentEvents({ limit: 25 }),
      };
    },
  },

  background: {
    enabled: backgroundRuntimeEnabled,
    configuredForBackground,
    start: startCryptoHubBackgroundRuntime,
    stop() {
      return cryptoHub.cryptoDataHub.stopBackgroundRefresh();
    },
  },
};

module.exports = {
  CryptoRuntime,
};
