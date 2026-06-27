const { randomUUID } = require("crypto");

const SLOW_REQUEST_MS = Number(process.env.COMMUNICATION_SLOW_REQUEST_MS) || 800;
const MAX_LOGGED_EVENTS = 500;
const recentEvents = [];

function nowMs() {
  const [seconds, nanos] = process.hrtime();
  return seconds * 1000 + nanos / 1e6;
}

function pushEvent(event) {
  recentEvents.push(event);
  if (recentEvents.length > MAX_LOGGED_EVENTS) {
    recentEvents.splice(0, recentEvents.length - MAX_LOGGED_EVENTS);
  }
}

function safeRequestBytes(request) {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength)) return contentLength;
  if (Buffer.isBuffer(request.rawBody)) return request.rawBody.length;
  if (typeof request.rawBody === "string") return Buffer.byteLength(request.rawBody);
  return 0;
}

function byteLengthForChunk(chunk, encoding) {
  if (!chunk) return 0;
  if (Buffer.isBuffer(chunk)) return chunk.length;
  const safeEncoding = typeof encoding === "string" ? encoding : undefined;
  return Buffer.byteLength(String(chunk), safeEncoding);
}

function routeScope(request, response) {
  return {
    userId:
      response.locals?.user?.id ||
      request.user?.id ||
      request.session?.user?.id ||
      null,
    workspaceSlug: request.params?.slug || null,
    threadSlug: request.params?.threadSlug || null,
  };
}

function communicationMetricsMiddleware(request, response, next) {
  const startedAt = nowMs();
  const requestId =
    request.headers["x-communication-request-id"] ||
    request.headers["x-request-id"] ||
    randomUUID();
  let responseBytes = 0;
  const originalWrite = response.write;
  const originalEnd = response.end;
  const originalWriteHead = response.writeHead;

  request.communicationRequestId = requestId;
  response.setHeader("X-Request-Id", requestId);

  response.writeHead = function writeHeadWithMetrics(...args) {
    if (!response.headersSent) {
      const durationMs = Math.round(nowMs() - startedAt);
      response.setHeader("Server-Timing", `app;dur=${durationMs}`);
    }
    return originalWriteHead.apply(this, args);
  };

  response.write = function writeWithMetrics(chunk, encoding, callback) {
    responseBytes += byteLengthForChunk(chunk, encoding);
    return originalWrite.call(this, chunk, encoding, callback);
  };

  response.end = function endWithMetrics(chunk, encoding, callback) {
    responseBytes += byteLengthForChunk(chunk, encoding);
    return originalEnd.call(this, chunk, encoding, callback);
  };

  response.on("finish", () => {
    const durationMs = Math.round(nowMs() - startedAt);
    const event = {
      requestId,
      method: request.method,
      path: request.originalUrl || request.url,
      route: request.route?.path || null,
      status: response.statusCode,
      durationMs,
      requestBytes: safeRequestBytes(request),
      responseBytes,
      createdAt: new Date().toISOString(),
      ...routeScope(request, response),
    };
    pushEvent(event);
    if (durationMs >= SLOW_REQUEST_MS) {
      console.warn("[communication:slow-request]", event);
    }
  });

  next();
}

function communicationMetricsSnapshot({ limit = 100 } = {}) {
  return recentEvents.slice(-limit);
}

module.exports = {
  communicationMetricsMiddleware,
  communicationMetricsSnapshot,
};
