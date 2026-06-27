const crypto = require("crypto");
const path = require("path");

const SENSITIVE_HEADER_PATTERN =
  /(^|[-_])(authorization|cookie|token|secret|signature|api[-_]?key|apikey|key)([-_]|$)/i;
const PATH_LIKE_PATTERN = /path|filepath|localpath|absolutepath/i;
const TITLE_LIKE_PATTERN = /title|documenttitle|booktitle/i;
const FILENAME_LIKE_PATTERN = /filename|originalname|basename|file/i;

function hashLogValue(value = "") {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex")
    .slice(0, 12);
}

function redactDocumentTitle(value = "") {
  if (!value) return value;
  return `[redacted-title:${hashLogValue(value)}]`;
}

function redactFilename(value = "") {
  if (!value) return value;
  const ext = path.extname(String(value)).slice(0, 16);
  return `[redacted-file:${hashLogValue(value)}${ext ? `:${ext}` : ""}]`;
}

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
  const fileName = String(value).split(/[\\/]/).filter(Boolean).pop();
  return fileName
    ? `[redacted-path]/${redactFilename(fileName)}`
    : "[redacted-path]";
}

function redactLogValue(key, value) {
  if (SENSITIVE_HEADER_PATTERN.test(String(key))) return "[redacted]";
  if (PATH_LIKE_PATTERN.test(String(key))) return redactFilePath(value);
  if (TITLE_LIKE_PATTERN.test(String(key))) return redactDocumentTitle(value);
  if (FILENAME_LIKE_PATTERN.test(String(key))) return redactFilename(value);
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

function redactLogText(value = "") {
  return String(value || "")
    .replace(/file:\/\/[^\s"')]+/g, "[redacted-file-url]")
    .replace(/\/Users\/[^\s"')]+/g, redactFilePath)
    .replace(/\/private\/[^\s"')]+/g, redactFilePath)
    .replace(/\/var\/folders\/[^\s"')]+/g, redactFilePath)
    .replace(
      /(-- Working Raw Text doc )(.+?)( --)?$/gm,
      (_match, prefix, title, suffix = "") =>
        `${prefix}${redactDocumentTitle(title.trim())}${suffix}`
    )
    .replace(/(-- Working )(.+?)( --)/g, (_match, prefix, file, suffix) => {
      const value = file.trim();
      if (/^https?:\/\//i.test(value)) {
        return `${prefix}${redactUrl(value)}${suffix}`;
      }
      return `${prefix}${redactFilename(value)}${suffix}`;
    })
    .replace(
      /(\[SUCCESS\]: )(.+?)( converted| transcribed| messages| fully processed)/g,
      (_match, prefix, file, suffix) =>
        `${prefix}${redactFilename(file.trim())}${suffix}`
    )
    .replace(
      /(Resulting (?:text content|mail items) (?:was|were) empty for )(.+?)(\.|$)/g,
      (_match, prefix, file, suffix) =>
        `${prefix}${redactFilename(file.trim())}${suffix}`
    )
    .replace(/(Sheet ")(.+?)(")/g, (_match, prefix, title, suffix) => {
      return `${prefix}${redactDocumentTitle(title.trim())}${suffix}`;
    })
    .replace(
      /(-- Working on message ")(.+?)(" --)/g,
      (_match, prefix, title, suffix) =>
        `${prefix}${redactDocumentTitle(title.trim())}${suffix}`
    );
}

function sanitizeLogArg(arg) {
  if (arg instanceof Error) {
    return redactLogText(arg.stack || arg.message || String(arg));
  }
  if (arg && typeof arg === "object") return redactLogObject(arg);
  if (typeof arg === "string") return redactLogText(arg);
  return arg;
}

function sanitizeLogArgs(args = []) {
  return Array.from(args).map(sanitizeLogArg);
}

module.exports = {
  hashLogValue,
  redactDocumentTitle,
  redactFilename,
  redactFilePath,
  redactHeaders,
  redactLogObject,
  redactLogText,
  redactLogValue,
  redactSensitiveText,
  redactUrl,
  sanitizeLogArg,
  sanitizeLogArgs,
};
