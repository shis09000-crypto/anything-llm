const crypto = require("crypto");

const BROWSER_RESULT_SCHEMA = "athena.browser.result.v1";
const BROWSER_DRIVER_CONTRACT = "athena.browser.driver.v1";
const BROWSER_ACTIONS = Object.freeze([
  "navigate",
  "back",
  "forward",
  "reload",
  "stop",
  "scroll",
  "click",
  "input",
  "key",
  "find",
  "zoom",
  "extract",
  "capture",
  "download",
  "upload",
  "submit",
  "fullscreen",
]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])])
  );
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function compactUrl(value = null) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 2048);
  } catch {
    return null;
  }
}

function browserResult({
  runId = crypto.randomUUID(),
  taskId = null,
  sessionId = null,
  tabId = null,
  status = "completed",
  action = null,
  observation = null,
  artifacts = [],
  citations = [],
  quality = {},
  approval = null,
  driver = "unknown",
  durationMs = 0,
  lineage = [],
  error = null,
} = {}) {
  const payload = {
    schemaVersion: BROWSER_RESULT_SCHEMA,
    runId,
    taskId,
    sessionId,
    tabId,
    status,
    action,
    observation,
    artifacts,
    citations,
    quality,
    approval,
    driver,
    durationMs: Math.max(0, Number(durationMs) || 0),
    lineage,
    error,
  };
  return {
    ...payload,
    resultSha256: sha256(payload),
  };
}

function publicObservation(observation = {}) {
  const source =
    observation && typeof observation === "object" ? observation : {};
  return {
    url: compactUrl(source.url),
    title: String(source.title || "").slice(0, 512),
    text: source.text == null ? null : String(source.text).slice(0, 50_000),
    viewport: source.viewport || null,
    canGoBack: Boolean(source.canGoBack),
    canGoForward: Boolean(source.canGoForward),
    loading: Boolean(source.loading),
    find: source.find || null,
    zoomFactor:
      source.zoomFactor == null ? null : Number(source.zoomFactor) || 1,
    frame: source.frame || null,
  };
}

module.exports = {
  BROWSER_ACTIONS,
  BROWSER_DRIVER_CONTRACT,
  BROWSER_RESULT_SCHEMA,
  browserResult,
  compactUrl,
  publicObservation,
  sha256,
  stableValue,
};
