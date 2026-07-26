const fs = require("fs");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");
const { storagePath } = require("../environment");

const taskStorage = new AsyncLocalStorage();
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_QUEUE_LIMIT = 20;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const PROCESS_ROUTES = new Set([
  "/process",
  "/parse",
  "/process-link",
  "/util/get-link",
  "/process-raw-text",
]);
let active = 0;
const pending = [];

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function taskConfig() {
  return {
    concurrency: positiveInteger(
      process.env.COLLECTOR_MAX_CONCURRENCY,
      DEFAULT_CONCURRENCY
    ),
    queueLimit: positiveInteger(
      process.env.COLLECTOR_MAX_QUEUE,
      DEFAULT_QUEUE_LIMIT
    ),
    timeoutMs: positiveInteger(
      process.env.COLLECTOR_TASK_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS
    ),
  };
}

function currentTask() {
  return taskStorage.getStore() || null;
}

function currentTaskSignal() {
  return currentTask()?.signal || null;
}

function currentTaskDirectory() {
  return currentTask()?.directory || null;
}

function isCollectorProcessingRoute(request = {}) {
  if (String(request.method || "").toUpperCase() !== "POST") return false;
  const route = String(request.path || "");
  return PROCESS_ROUTES.has(route) || route.startsWith("/ext/");
}

function cleanupTaskDirectory(directory) {
  if (!directory) return;
  const root = path.resolve(storagePath("tmp"));
  const target = path.resolve(directory);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    return;
  fs.rmSync(target, { recursive: true, force: true });
}

function startNext() {
  const { concurrency } = taskConfig();
  while (active < concurrency && pending.length > 0) {
    const queued = pending.shift();
    if (queued.closed) continue;
    startTask(queued);
  }
}

function startTask({ request, response, next }) {
  active += 1;
  const { timeoutMs } = taskConfig();
  const tempRoot = storagePath("tmp");
  fs.mkdirSync(tempRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(tempRoot, "collector-job-"));
  const controller = new AbortController();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    cleanupTaskDirectory(directory);
    active = Math.max(0, active - 1);
    startNext();
  };
  const timer = setTimeout(() => {
    controller.abort(new Error("Collector task timed out."));
    if (!response.headersSent) {
      response.status(504).json({
        success: false,
        error: "collector_timeout",
      });
    }
  }, timeoutMs);
  response.once("finish", release);
  response.once("close", () => {
    if (!response.writableFinished)
      controller.abort(new Error("Collector client connection closed."));
    release();
  });
  request.collectorTask = {
    directory,
    signal: controller.signal,
    operationContext: {
      operationId: request.headers?.["x-athena-operation-id"] || null,
      interactionId: request.headers?.["x-athena-interaction-id"] || null,
      requestId: request.headers?.["x-request-id"] || null,
      traceparent: request.headers?.traceparent || null,
    },
  };
  taskStorage.run(request.collectorTask, next);
}

function collectorTaskGuard(request, response, next) {
  const { concurrency, queueLimit } = taskConfig();
  if (active < concurrency) {
    startTask({ request, response, next });
    return;
  }
  if (pending.length >= queueLimit) {
    response.set("Retry-After", "1");
    response.status(429).json({ success: false, error: "collector_busy" });
    return;
  }
  const queued = { request, response, next, closed: false };
  pending.push(queued);
  request.once("aborted", () => {
    queued.closed = true;
  });
}

function taskStats() {
  return { active, queued: pending.filter((item) => !item.closed).length };
}

module.exports = {
  collectorTaskGuard,
  currentTask,
  currentTaskDirectory,
  currentTaskSignal,
  isCollectorProcessingRoute,
  taskStats,
  _private: { cleanupTaskDirectory, taskConfig },
};
