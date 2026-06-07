const SENSITIVE_KEY_PATTERN =
  /key|secret|sign|signature|authorization|auth|token|password|credential/i;

function safeErrorMessage(error) {
  const message =
    typeof error === "string" ? error : error?.message || "Unknown error";
  return message
    .replace(/KEY=[^&\s]+/gi, "KEY=[redacted]")
    .replace(/SIGN=[^&\s]+/gi, "SIGN=[redacted]")
    .replace(/secret[^,\s]*/gi, "secret[redacted]")
    .slice(0, 600);
}

function sanitizePayload(value, depth = 0) {
  if (depth > 5) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizePayload(item, depth + 1));
  }
  if (typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (SENSITIVE_KEY_PATTERN.test(key)) return [key, "[redacted]"];
      return [key, sanitizePayload(item, depth + 1)];
    })
  );
}

function samplePayload(value) {
  if (Array.isArray(value)) return sanitizePayload(value.slice(0, 2));
  return sanitizePayload(value);
}

function rawLength(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return value === undefined || value === null ? 0 : 1;
}

module.exports = {
  rawLength,
  safeErrorMessage,
  samplePayload,
  sanitizePayload,
};
