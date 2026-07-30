const { isSecretEncrypted, readSecret } = require("../../../../security");
const { MarketDataError } = require("./lib");

const SECRET_ENV_KEYS = Object.freeze({
  qweather: "QWEATHER_API_KEY_ENCRYPTED",
  juheStock: "JUHE_STOCK_API_KEY_ENCRYPTED",
  juheForex: "JUHE_FOREX_API_KEY_ENCRYPTED",
  twelveData: "TWELVE_DATA_API_KEY_ENCRYPTED",
});

function readManagedSecret(name) {
  const envKey = SECRET_ENV_KEYS[name];
  if (!envKey)
    throw new MarketDataError(
      "secret_not_declared",
      "Unknown provider secret."
    );
  const encrypted = process.env[envKey];
  if (!encrypted)
    throw new MarketDataError(
      "provider_not_configured",
      `${name} provider credentials are not configured.`
    );
  if (!isSecretEncrypted(encrypted))
    throw new MarketDataError(
      "provider_secret_unavailable",
      `${name} provider credentials are unavailable.`
    );
  try {
    const value = readSecret(encrypted);
    if (!value) throw new Error("empty secret");
    return value;
  } catch {
    throw new MarketDataError(
      "provider_secret_unavailable",
      `${name} provider credentials are unavailable.`
    );
  }
}

function managedSecretStatus() {
  return Object.fromEntries(
    Object.entries(SECRET_ENV_KEYS).map(([name, envKey]) => [
      name,
      Boolean(process.env[envKey]),
    ])
  );
}

module.exports = { SECRET_ENV_KEYS, managedSecretStatus, readManagedSecret };
