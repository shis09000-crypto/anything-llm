const crypto = require("crypto");

const DEFAULT_EXCLUDED_KEYS = new Set([
  "createdAt",
  "updatedAt",
  "lastUpdatedAt",
  "lastSeenAt",
]);
const SENSITIVE_KEY_PATTERN =
  /(password|secret|token|credential|authorization|api[_-]?key|private[_-]?key|encryptedPayload|signingSecret)/i;

function normalizeCanonical(value, options = {}, seen = new WeakSet()) {
  const excludedKeys = options.excludedKeys || DEFAULT_EXCLUDED_KEYS;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (value === undefined || typeof value === "function") return undefined;
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) throw new Error("canonical_json_cycle");
  seen.add(value);

  if (Array.isArray(value)) {
    const normalized = value.map((entry) => {
      const next = normalizeCanonical(entry, options, seen);
      return next === undefined ? null : next;
    });
    seen.delete(value);
    return normalized;
  }

  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    if (excludedKeys.has(key)) continue;
    if (options.excludeSensitive !== false && SENSITIVE_KEY_PATTERN.test(key))
      continue;
    const next = normalizeCanonical(value[key], options, seen);
    if (next !== undefined) normalized[key] = next;
  }
  seen.delete(value);
  return normalized;
}

function canonicalJson(value, options = {}) {
  return JSON.stringify(normalizeCanonical(value, options));
}

function contentHash(value, options = {}) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(canonicalJson(value, options), "utf8")
    .digest("hex")}`;
}

module.exports = {
  DEFAULT_EXCLUDED_KEYS,
  SENSITIVE_KEY_PATTERN,
  canonicalJson,
  contentHash,
  normalizeCanonical,
};
