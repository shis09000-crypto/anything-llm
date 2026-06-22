const SENSITIVE_HEADER_PATTERN =
  /(^|[-_])(authorization|cookie|token|secret|signature|api[-_]?key|apikey|key)([-_]|$)/i;
const PATH_LIKE_PATTERN =
  /(^|[-_])(path|filepath|localpath|absolutepath)([-_]|$)/i;

function redactUrl(value = "") {
  try {
    const url = new URL(String(value));
    return [
      url.origin,
      url.pathname,
      url.search ? "?[redacted]" : "",
      url.hash ? "#[redacted]" : "",
    ].join("");
  } catch {
    return "[redacted-link]";
  }
}

function redactHeaders(headers = {}) {
  if (!headers || typeof headers !== "object") return {};
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      SENSITIVE_HEADER_PATTERN.test(String(key)) ? "[redacted]" : value,
    ])
  );
}

function redactFilePath(value = "") {
  if (!value) return value;
  const text = String(value);
  const fileName = text.split(/[\\/]/).filter(Boolean).pop();
  return fileName ? `[redacted-path]/${fileName}` : "[redacted-path]";
}

function redactLogValue(key, value) {
  if (SENSITIVE_HEADER_PATTERN.test(String(key))) return "[redacted]";
  if (PATH_LIKE_PATTERN.test(String(key))) return redactFilePath(value);
  if (typeof value === "string") {
    try {
      const parsed = new URL(value);
      if (parsed.search || parsed.hash) return redactUrl(value);
    } catch {}
  }
  return value;
}

function redactLogObject(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? redactLogObject(entry)
        : redactLogValue(key, entry),
    ])
  );
}

function redactSensitiveText(value = "", secrets = []) {
  let text = String(value || "");
  for (const secret of secrets) {
    if (!secret) continue;
    text = text.split(String(secret)).join(redactUrl(secret));
  }
  return text;
}

module.exports = {
  redactFilePath,
  redactHeaders,
  redactLogObject,
  redactLogValue,
  redactSensitiveText,
  redactUrl,
};
