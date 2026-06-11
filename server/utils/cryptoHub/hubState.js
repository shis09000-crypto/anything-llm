const SERVICE_KEYS = [
  "equity",
  "allocation",
  "openFuturesPositions",
  "topAssets",
  "marketCandles",
  "tradeRecords",
  "tradingPairDetail",
  "btcSummary",
];

function now() {
  return Date.now();
}

class CryptoHubState {
  constructor() {
    this.startedAt = null;
    this.lastInitAt = null;
    this.lastError = null;
    this.services = Object.fromEntries(
      SERVICE_KEYS.map((key) => [
        key,
        {
          status: "loading",
          updatedAt: null,
          safeErrorMessage: null,
          freshness: null,
          partialFailures: [],
        },
      ])
    );
  }

  start() {
    if (!this.startedAt) this.startedAt = now();
    this.lastInitAt = now();
  }

  serviceStatus(key) {
    return this.services[key]?.status || "loading";
  }

  setService(key, patch = {}) {
    if (!this.services[key]) {
      this.services[key] = {
        status: "loading",
        updatedAt: null,
        safeErrorMessage: null,
        freshness: null,
        partialFailures: [],
      };
    }
    this.services[key] = {
      ...this.services[key],
      ...patch,
      updatedAt: now(),
    };
    if (patch.safeErrorMessage) this.lastError = patch.safeErrorMessage;
  }

  markLoading(key) {
    this.setService(key, {
      status: "loading",
      safeErrorMessage: null,
      partialFailures: [],
    });
  }

  markFromPayload(key, payload = {}) {
    const connectionStatus = payload.connectionStatus;
    const partialFailures = Array.isArray(payload.partialFailures)
      ? payload.partialFailures
      : [];
    const safeErrorMessage = payload.safeErrorMessage || payload.error || null;
    let status = "ready";
    if (connectionStatus === "degraded" || partialFailures.length) {
      status = "degraded";
    }
    if (connectionStatus === "disconnected" || payload.success === false) {
      status = safeErrorMessage ? "error" : "degraded";
    }

    this.setService(key, {
      status,
      safeErrorMessage,
      partialFailures,
      freshness: payload.freshness || payload.cache || null,
    });
  }

  markError(key, errorMessage) {
    this.setService(key, {
      status: "error",
      safeErrorMessage: errorMessage || "Crypto Hub service failed.",
    });
  }

  snapshot() {
    return {
      startedAt: this.startedAt,
      lastInitAt: this.lastInitAt,
      lastError: this.lastError,
      services: Object.fromEntries(
        Object.entries(this.services).map(([key, value]) => [key, value.status])
      ),
      serviceDetails: this.services,
    };
  }
}

module.exports = {
  CryptoHubState,
  SERVICE_KEYS,
};
