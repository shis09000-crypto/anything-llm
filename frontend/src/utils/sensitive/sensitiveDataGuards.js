const SENSITIVE_KEY_RE =
  /(^|[._:-])(secret|token|password|credential|api[-_]?key|vault|signing[-_]?secret|private[-_]?config|sensitive[-_]?session|grant|authorization|cookie|original[-_]?url|absolute[-_]?path|local[-_]?path)([._:-]|$)/i;
const SENSITIVE_QUERY_RE =
  /([?&](?:token|auth|authorization|access_token|refresh_token|sensitiveSession|sensitive_session|signature|signingSecret|signing_secret|apiKey|api_key|key|secret)=)[^&#\s]+/gi;

function redactUrlString(value = "") {
  const text = String(value || "");
  if (!/[?&]/.test(text)) return text;
  return text.replace(SENSITIVE_QUERY_RE, "$1[redacted]");
}

export function isSensitiveStateKey(value = "") {
  return SENSITIVE_KEY_RE.test(String(value || ""));
}

export function assertNonSensitiveCacheKey(key, meta = {}) {
  if (meta?.sensitive === true || isSensitiveStateKey(key)) {
    const error = new Error(
      "Sensitive state is not allowed in ServerStateCache."
    );
    error.code = "SENSITIVE_SERVER_STATE_FORBIDDEN";
    error.key = key;
    throw error;
  }
}

export function redactSensitiveValue(value, keyHint = "") {
  if (value === null || value === undefined) return value;
  if (isSensitiveStateKey(keyHint)) return "[redacted-sensitive]";
  if (typeof value === "string") return redactUrlString(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValue(item, keyHint));
  }
  if (typeof value === "object") {
    return Object.entries(value).reduce((acc, [key, nextValue]) => {
      acc[key] = redactSensitiveValue(nextValue, key);
      return acc;
    }, {});
  }
  return value;
}

export function redactSensitiveSnapshotEntry(entry = {}) {
  if (!entry || typeof entry !== "object") return entry;
  const key = entry.key || entry.dedupeKey || entry.label || "";
  if (isSensitiveStateKey(key)) {
    return {
      ...entry,
      key: entry.key ? "[redacted-sensitive-key]" : entry.key,
      dedupeKey: entry.dedupeKey ? "[redacted-sensitive-key]" : entry.dedupeKey,
      label: entry.label ? "[redacted-sensitive-label]" : entry.label,
      scope: redactSensitiveValue(entry.scope || {}, "scope"),
      ownerScope: entry.ownerScope
        ? "[redacted-sensitive-owner]"
        : entry.ownerScope,
      meta: redactSensitiveValue(entry.meta || {}, "meta"),
    };
  }
  return redactSensitiveValue(entry, key);
}
