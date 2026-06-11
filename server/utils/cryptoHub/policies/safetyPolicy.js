const FORBIDDEN_RESPONSE_KEYS = [
  "KEY",
  "SIGN",
  "secret",
  "apiSecret",
  "api_key",
  "apiSecretEncrypted",
  "GATE_API_SECRET",
];

function assertReadOnlyOperation(operation = "") {
  const normalized = String(operation).toLowerCase();
  const forbidden = [
    "order",
    "withdraw",
    "transfer",
    "close-position",
    "cancel",
    "leverage",
    "take-profit",
    "stop-loss",
  ];
  if (forbidden.some((word) => normalized.includes(word))) {
    const error = new Error("Crypto Hub only supports read-only operations.");
    error.code = "crypto_hub_readonly_violation";
    throw error;
  }
}

function redactSensitive(value) {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      FORBIDDEN_RESPONSE_KEYS.some((forbiddenKey) =>
        key.toLowerCase().includes(forbiddenKey.toLowerCase())
      )
        ? "[redacted]"
        : redactSensitive(entryValue),
    ])
  );
}

module.exports = {
  assertReadOnlyOperation,
  redactSensitive,
};
