const crypto = require("crypto");
const fs = require("fs");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const {
  requestInternalService,
  requestInternalStream,
} = require("../microModules/internalClient");
const { BrowserWorkerRuntime } = require("./workerRuntime");

let inlineRuntime = null;

function distributed(env = process.env) {
  return ["distributed", "micro-modules"].includes(
    String(env.ATHENA_RUNTIME_TOPOLOGY || "")
      .trim()
      .toLowerCase()
  );
}

function endpoint(env = process.env) {
  return String(
    env.ATHENA_BROWSER_WORKER_URL || "http://127.0.0.1:3031"
  ).replace(/\/+$/, "");
}

function localWorker() {
  if (!inlineRuntime) {
    inlineRuntime = new BrowserWorkerRuntime();
    inlineRuntime.start();
  }
  return inlineRuntime;
}

async function callRemote(
  path,
  body,
  { method = "POST", timeoutMs = 30_000 } = {}
) {
  return requestInternalService({
    callerRole:
      process.env.ATHENA_RUNTIME_ROLE === "api"
        ? "athena-api"
        : "browser-plane",
    url: `${endpoint()}${path}`,
    method,
    body,
    env: process.env,
    timeoutMs,
    idempotencyKey: body?.idempotencyKey || null,
  });
}

async function workerCreateSession(options = {}) {
  if (!distributed()) return localWorker().createSession(options);
  return (await callRemote("/internal/v1/browser/sessions", options)).session;
}

async function workerSession(sessionId, userRef) {
  if (!distributed())
    return localWorker().sessionSnapshot(
      localWorker().requireSession(sessionId, userRef)
    );
  return (
    await callRemote(
      `/internal/v1/browser/sessions/${encodeURIComponent(sessionId)}?userRef=${encodeURIComponent(userRef)}`,
      null,
      { method: "GET", timeoutMs: 10_000 }
    )
  ).session;
}

async function workerAction(options = {}) {
  if (!distributed()) return localWorker().action(options);
  return (
    await callRemote(
      `/internal/v1/browser/sessions/${encodeURIComponent(options.sessionId)}/actions`,
      options,
      { timeoutMs: 35_000 }
    )
  ).result;
}

async function workerNewTab(options = {}) {
  if (!distributed())
    return localWorker().newTab(
      options.sessionId,
      options.userRef,
      options.url
    );
  return (
    await callRemote(
      `/internal/v1/browser/sessions/${encodeURIComponent(options.sessionId)}/tabs`,
      options
    )
  ).session;
}

async function workerCloseTab(options = {}) {
  if (!distributed())
    return localWorker().closeTab(
      options.sessionId,
      options.userRef,
      options.tabId
    );
  return (
    await callRemote(
      `/internal/v1/browser/sessions/${encodeURIComponent(options.sessionId)}/tabs/${encodeURIComponent(options.tabId)}`,
      options,
      { method: "DELETE" }
    )
  ).session;
}

async function workerCookieSummary(options = {}) {
  if (!distributed())
    return localWorker().cookieSiteSummary(options.sessionId, options.userRef);
  return (
    await callRemote(
      `/internal/v1/browser/sessions/${encodeURIComponent(options.sessionId)}/cookies?userRef=${encodeURIComponent(options.userRef)}`,
      null,
      { method: "GET" }
    )
  ).sites;
}

async function workerClearCookieSite(options = {}) {
  if (!distributed())
    return localWorker().clearCookieSite(
      options.sessionId,
      options.userRef,
      options.domain
    );
  return (
    await callRemote(
      `/internal/v1/browser/sessions/${encodeURIComponent(options.sessionId)}/cookies/clear`,
      options
    )
  ).result;
}

async function workerCloseSession(options = {}) {
  if (!distributed())
    return localWorker().closeSession(options.sessionId, options);
  return (
    await callRemote(
      `/internal/v1/browser/sessions/${encodeURIComponent(options.sessionId)}/close`,
      options
    )
  ).session;
}

async function workerDeleteProfile(options = {}) {
  if (!distributed())
    return localWorker().deleteProfile(options.profileId, {
      objectRef: options.objectRef || null,
    });
  return (
    await callRemote(
      `/internal/v1/browser/profiles/${encodeURIComponent(options.profileId)}`,
      options,
      { method: "DELETE" }
    )
  ).result;
}

async function workerStreamTicket(options = {}) {
  if (!distributed()) return localWorker().issueStreamTicket(options);
  return (
    await callRemote(
      `/internal/v1/browser/sessions/${encodeURIComponent(options.sessionId)}/stream-ticket`,
      options,
      { timeoutMs: 10_000 }
    )
  ).stream;
}

async function workerInspectActionRisk(options = {}) {
  if (!distributed()) return localWorker().inspectActionRisk(options);
  return (
    await callRemote(
      `/internal/v1/browser/sessions/${encodeURIComponent(options.sessionId)}/risk-inspection`,
      options,
      { timeoutMs: 10_000 }
    )
  ).risk;
}

async function persistDownloadStream(
  stream,
  destinationPath,
  { maxBytes, expectedBytes = null } = {}
) {
  let bytes = 0;
  const hash = crypto.createHash("sha256");
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes)
        return callback(
          Object.assign(new Error("browser_download_too_large"), {
            code: "browser_download_too_large",
            httpStatus: 413,
          })
        );
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      stream,
      limiter,
      fs.createWriteStream(destinationPath, { flags: "wx", mode: 0o600 })
    );
    if (expectedBytes !== null && bytes !== Number(expectedBytes))
      throw Object.assign(new Error("browser_download_size_mismatch"), {
        code: "browser_download_size_mismatch",
        httpStatus: 502,
      });
    return { bytes, sha256: hash.digest("hex") };
  } catch (error) {
    await fs.promises.rm(destinationPath, { force: true });
    throw error;
  }
}

async function workerDownloadToFile(
  options = {},
  destinationPath,
  { maxBytes = 25 * 1024 * 1024 } = {}
) {
  if (!distributed()) {
    const download = localWorker().downloadFile(
      options.sessionId,
      options.userRef,
      options.downloadId
    );
    return persistDownloadStream(
      fs.createReadStream(download.filePath),
      destinationPath,
      { maxBytes, expectedBytes: options.expectedBytes ?? download.bytes }
    );
  }
  const response = await requestInternalStream({
    callerRole:
      process.env.ATHENA_RUNTIME_ROLE === "api"
        ? "athena-api"
        : "browser-plane",
    url:
      `${endpoint()}/internal/v1/browser/sessions/` +
      `${encodeURIComponent(options.sessionId)}/downloads/` +
      `${encodeURIComponent(options.downloadId)}?userRef=` +
      encodeURIComponent(options.userRef),
    method: "GET",
    env: process.env,
    timeoutMs: 30_000,
  });
  return persistDownloadStream(response, destinationPath, {
    maxBytes,
    expectedBytes: options.expectedBytes,
  });
}

async function workerDeleteDownload(options = {}) {
  if (!distributed())
    return localWorker().deleteDownload(
      options.sessionId,
      options.userRef,
      options.downloadId
    );
  return (
    await callRemote(
      `/internal/v1/browser/sessions/${encodeURIComponent(options.sessionId)}/downloads/${encodeURIComponent(options.downloadId)}`,
      options,
      { method: "DELETE", timeoutMs: 10_000 }
    )
  ).result;
}

module.exports = {
  distributed,
  endpoint,
  localWorker,
  persistDownloadStream,
  workerAction,
  workerClearCookieSite,
  workerCloseSession,
  workerCloseTab,
  workerCookieSummary,
  workerCreateSession,
  workerDeleteProfile,
  workerDeleteDownload,
  workerDownloadToFile,
  workerNewTab,
  workerInspectActionRisk,
  workerSession,
  workerStreamTicket,
};
