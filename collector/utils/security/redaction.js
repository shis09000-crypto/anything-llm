const SENSITIVE_HEADER_PATTERN =
  /(^|[-_])(authorization|cookie|token|secret|signature|api[-_]?key|apikey|key)([-_]|$)/i;

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

function redactSensitiveText(value = "", secrets = []) {
  let text = String(value || "");
  for (const secret of secrets) {
    if (!secret) continue;
    text = text.split(String(secret)).join(redactUrl(secret));
  }
  return text;
}

module.exports = {
  redactHeaders,
  redactSensitiveText,
  redactUrl,
};
