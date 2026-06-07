const { readSecret } = require("../security");
const { maskSecret } = require("./maskSecret");

function boolEnv(value) {
  return String(value || "").toLowerCase() === "true";
}

function getGateConfigStatus() {
  const encryptedKey = process.env.GATE_API_KEY_ENCRYPTED;
  const encryptedSecret = process.env.GATE_API_SECRET_ENCRYPTED;
  const rawKey = process.env.GATE_API_KEY;
  const rawSecret = process.env.GATE_API_SECRET;
  const apiKey = encryptedKey ? readSecret(encryptedKey) : rawKey;
  const apiSecret = encryptedSecret ? readSecret(encryptedSecret) : rawSecret;

  return {
    enabled: boolEnv(process.env.GATE_CRYPTO_ENABLED),
    env: process.env.GATE_API_ENV || "production",
    hasApiKey: Boolean(apiKey),
    hasApiSecret: Boolean(apiSecret),
    maskedApiKey: maskSecret(apiKey),
    readOnly: boolEnv(process.env.GATE_API_READONLY),
  };
}

function getGateCredentials() {
  const status = getGateConfigStatus();
  if (!status.enabled) {
    const error = new Error("Gate crypto probe is disabled.");
    error.code = "gate_crypto_disabled";
    throw error;
  }
  if (!status.readOnly) {
    const error = new Error(
      "Gate API is not marked read-only. Refusing to connect."
    );
    error.code = "gate_api_not_readonly";
    throw error;
  }

  const apiKey = process.env.GATE_API_KEY_ENCRYPTED
    ? readSecret(process.env.GATE_API_KEY_ENCRYPTED)
    : process.env.GATE_API_KEY;
  const apiSecret = process.env.GATE_API_SECRET_ENCRYPTED
    ? readSecret(process.env.GATE_API_SECRET_ENCRYPTED)
    : process.env.GATE_API_SECRET;

  if (!apiKey || !apiSecret) {
    const error = new Error("Gate API credentials are missing.");
    error.code = "gate_credentials_missing";
    throw error;
  }

  return {
    apiKey,
    apiSecret,
    env: status.env,
  };
}

module.exports = {
  getGateConfigStatus,
  getGateCredentials,
};
