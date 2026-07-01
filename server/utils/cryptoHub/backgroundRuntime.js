const { safeErrorMessage } = require("../cryptoGate");
const { cryptoDataHub } = require("./CryptoDataHub");

function boolEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  return String(value).toLowerCase() === "true";
}

function backgroundRuntimeEnabled() {
  return boolEnv(process.env.CRYPTO_HUB_BACKGROUND_ENABLED, true);
}

function configuredForBackground(status = {}) {
  return Boolean(
    status.enabled &&
      status.readOnly &&
      status.gate?.configured &&
      status.gate?.privateRest !== "disconnected"
  );
}

async function startCryptoHubBackgroundRuntime({
  hub = cryptoDataHub,
  logger = console,
} = {}) {
  if (!backgroundRuntimeEnabled()) {
    return {
      started: false,
      skipped: true,
      reason: "disabled",
    };
  }

  const status = hub.getStatus();
  if (!configuredForBackground(status)) {
    return {
      started: false,
      skipped: true,
      reason: "gate_not_configured",
      status,
    };
  }

  try {
    const startStatus = hub.start();
    let prewarm = null;
    try {
      prewarm = await hub.services?.equity?.prewarm?.();
      if (prewarm) {
        hub.state?.markFromPayload?.("equity", prewarm?.history || prewarm);
      }
    } catch (error) {
      const message = safeErrorMessage(error);
      hub.state?.markError?.("equity", message);
      logger.warn?.(`[CryptoHubBackground] equity prewarm failed: ${message}`);
    }

    return {
      started: true,
      skipped: false,
      status: startStatus,
      prewarm,
    };
  } catch (error) {
    const message = safeErrorMessage(error);
    logger.warn?.(`[CryptoHubBackground] start failed: ${message}`);
    return {
      started: false,
      skipped: false,
      error: message,
    };
  }
}

module.exports = {
  backgroundRuntimeEnabled,
  configuredForBackground,
  startCryptoHubBackgroundRuntime,
};
