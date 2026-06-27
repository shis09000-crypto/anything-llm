const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { sseTransportHeaders } = require("../utils/security/transportSecurity");
const { ensureStoragePath } = require("../utils/environment");
const {
  redactLogObject,
  redactLogText,
} = require("../utils/security/redaction");
const {
  communicationMetricsSnapshot,
} = require("../middleware/communicationMetrics");

const DEBUG_PREFIX = "/debug/communication";
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 64 * 1024 * 1024 },
}).single("file");

function communicationDebugEnabled() {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.ATHENA_COMMUNICATION_DEBUG === "1"
  );
}

function mobileClientDebugEnabled() {
  return (
    communicationDebugEnabled() ||
    (process.env.NODE_ENV !== "production" &&
      process.env.ATHENA_MOBILE_CLIENT_DEBUG !== "0")
  );
}

function guardDebug(_request, response, next) {
  if (!communicationDebugEnabled()) return response.sendStatus(404);
  return next();
}

function guardMobileClientDebug(_request, response, next) {
  if (!mobileClientDebugEnabled()) return response.sendStatus(404);
  return next();
}

function intValue(value, fallback = 0, { min = 0, max = 60_000 } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scenario(request) {
  return String(request.query?.scenario || request.body?.scenario || "ok");
}

function requestId(request) {
  return (
    request.header?.("x-athena-test-request-id") ||
    request.body?.requestId ||
    crypto.randomUUID()
  );
}

function writeSse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeRawSse(response, value) {
  response.write(`data: ${value}\n\n`);
}

async function writeChunkedSse(response, chunks = [], delayMs = 0) {
  for (const chunk of chunks) {
    response.write(chunk);
    if (delayMs > 0) await wait(delayMs);
  }
}

function debugJsonEndpoints(app) {
  app.get(`${DEBUG_PREFIX}/metrics`, guardDebug, (request, response) => {
    const limit = intValue(request.query?.limit, 100, { min: 1, max: 500 });
    response.status(200).json({
      success: true,
      events: communicationMetricsSnapshot({ limit }),
    });
  });

  app.all(`${DEBUG_PREFIX}/json`, guardDebug, async (request, response) => {
    const delayMs = intValue(request.query?.delayMs || request.body?.delayMs);
    const status = intValue(
      request.query?.status || request.body?.status,
      200,
      { min: 100, max: 599 }
    );
    const mode = scenario(request);

    if (delayMs) await wait(delayMs);
    if (mode === "malformed") {
      response.status(status).type("application/json").send("{bad-json");
      return;
    }

    const sizeBytes = intValue(
      request.query?.sizeBytes || request.body?.sizeBytes,
      0,
      { min: 0, max: 1024 * 1024 }
    );
    response.status(status).json({
      success: status < 400,
      requestId: requestId(request),
      method: request.method,
      scenario: mode,
      delayMs,
      payload: sizeBytes ? "x".repeat(sizeBytes) : null,
      body: request.body || null,
    });
  });
}

function debugUploadEndpoints(app) {
  app.post(`${DEBUG_PREFIX}/upload`, guardDebug, (request, response) => {
    upload(request, response, async (error) => {
      if (error) {
        response.status(400).json({
          success: false,
          error: error.message,
          requestId: requestId(request),
        });
        return;
      }

      const delayMs = intValue(request.query?.delayMs || request.body?.delayMs);
      const status = intValue(
        request.query?.status || request.body?.status,
        200,
        { min: 100, max: 599 }
      );
      if (delayMs) await wait(delayMs);

      response.status(status).json({
        success: status < 400,
        requestId: requestId(request),
        filename: request.file?.originalname || null,
        mimetype: request.file?.mimetype || null,
        size: request.file?.size || 0,
        fields: request.body || {},
        error: status >= 400 ? `debug_upload_${status}` : null,
      });
    });
  });
}

function debugBlobEndpoints(app) {
  app.all(`${DEBUG_PREFIX}/blob`, guardDebug, async (request, response) => {
    const delayMs = intValue(request.query?.delayMs || request.body?.delayMs);
    const status = intValue(
      request.query?.status || request.body?.status,
      200,
      { min: 100, max: 599 }
    );
    const sizeBytes = intValue(
      request.query?.sizeBytes || request.body?.sizeBytes,
      1024,
      { min: 0, max: 16 * 1024 * 1024 }
    );
    const contentType =
      request.query?.contentType || request.body?.contentType || "text/plain";
    const filename = request.query?.filename || request.body?.filename;

    if (delayMs) await wait(delayMs);
    if (status >= 400) {
      response.status(status).json({
        success: false,
        error: `debug_blob_${status}`,
        requestId: requestId(request),
      });
      return;
    }

    response.status(status).setHeader("Content-Type", contentType);
    response.setHeader("X-Athena-Debug-Request-Id", requestId(request));
    if (filename) {
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );
    }
    response.send(Buffer.alloc(sizeBytes, "a"));
  });

  app.all(`${DEBUG_PREFIX}/text`, guardDebug, async (request, response) => {
    const delayMs = intValue(request.query?.delayMs || request.body?.delayMs);
    const status = intValue(
      request.query?.status || request.body?.status,
      200,
      { min: 100, max: 599 }
    );
    if (delayMs) await wait(delayMs);
    if (status >= 400) {
      response.status(status).type("text/plain").send(`debug_text_${status}`);
      return;
    }
    response
      .status(status)
      .type("text/plain")
      .send(`debug-text:${requestId(request)}`);
  });
}

function debugStreamEndpoints(app) {
  app.post(`${DEBUG_PREFIX}/sse`, guardDebug, async (request, response) => {
    const mode = scenario(request);
    const delayMs = intValue(request.query?.delayMs || request.body?.delayMs);
    const events = intValue(request.query?.events || request.body?.events, 3, {
      min: 1,
      max: 1_000,
    });

    if (mode === "open_error") {
      response.status(503).json({
        success: false,
        error: "debug_sse_open_error",
        requestId: requestId(request),
      });
      return;
    }

    response.writeHead(200, sseTransportHeaders());

    if (mode === "malformed") {
      writeRawSse(response, "{bad-json");
      response.end();
      return;
    }

    if (mode === "split") {
      await writeChunkedSse(
        response,
        [
          'data: {"type":"progress","index":1',
          ',"requestId":"',
          requestId(request),
          '"}\n\n',
          `data: ${JSON.stringify({ type: "success", index: 2 })}\n\n`,
        ],
        delayMs
      );
      response.end();
      return;
    }

    if (mode === "glued") {
      response.write(
        `data: ${JSON.stringify({ type: "progress", index: 1 })}\n\ndata: ${JSON.stringify({ type: "progress", index: 2 })}\n\n`
      );
      response.end();
      return;
    }

    for (let index = 1; index <= events; index += 1) {
      writeSse(response, {
        type: index === events ? "success" : "progress",
        index,
        percentage: Math.round((index / events) * 100),
        requestId: requestId(request),
      });
      if (mode === "mid_close" && index === Math.ceil(events / 2)) {
        response.destroy();
        return;
      }
      if (delayMs) await wait(delayMs);
    }

    if (mode === "late_error") {
      writeSse(response, {
        type: "error",
        message: "debug_late_error",
        requestId: requestId(request),
      });
    }
    response.end();
  });
}

const MOBILE_CLIENT_LOG_FILE = "mobile-client-debug.log";
const MOBILE_CLIENT_LOG_MAX_EVENTS = 80;
const MOBILE_CLIENT_LOG_MAX_TEXT = 1_000;
const MOBILE_CLIENT_LOG_TAIL_MAX_LINES = 500;

function boundedString(value = "", max = MOBILE_CLIENT_LOG_MAX_TEXT) {
  const text = redactLogText(String(value || ""));
  return text.length > max ? `${text.slice(0, max)}...[truncated]` : text;
}

function sanitizeMobileLogValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 6) return "[max-depth]";
  if (typeof value === "string") return boundedString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, 80)
      .map((item) => sanitizeMobileLogValue(item, depth + 1));
  }
  if (typeof value === "object") {
    return redactLogObject(
      Object.fromEntries(
        Object.entries(value)
          .slice(0, 120)
          .map(([key, entry]) => [
            boundedString(key, 120),
            sanitizeMobileLogValue(entry, depth + 1),
          ])
      )
    );
  }
  return boundedString(String(value));
}

function mobileClientLogPath() {
  return path.join(ensureStoragePath("logs"), MOBILE_CLIENT_LOG_FILE);
}

function mobileClientLogEvents(body = {}) {
  const events = Array.isArray(body.events)
    ? body.events
    : [body.event || body];
  return events
    .filter(Boolean)
    .slice(0, MOBILE_CLIENT_LOG_MAX_EVENTS)
    .map((event) => sanitizeMobileLogValue(event));
}

function appendMobileClientLogs({ request, events = [] }) {
  if (!events.length) return { written: 0, file: mobileClientLogPath() };
  const file = mobileClientLogPath();
  const receivedAt = new Date().toISOString();
  const requestMeta = sanitizeMobileLogValue({
    ip: request.ip,
    userAgent: request.get?.("user-agent") || null,
    origin: request.get?.("origin") || null,
    referer: request.get?.("referer") || null,
    clientRequestId: request.get?.("x-athena-client-debug-request-id") || null,
  });
  const lines = events.map((event) =>
    JSON.stringify({
      receivedAt,
      request: requestMeta,
      event,
    })
  );
  fs.appendFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return { written: lines.length, file };
}

function tailFileLines(file, limit = 100) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
  return lines.slice(-Math.min(limit, MOBILE_CLIENT_LOG_TAIL_MAX_LINES));
}

function debugMobileClientLogEndpoints(app) {
  app.post(
    `${DEBUG_PREFIX}/mobile-client-log`,
    guardMobileClientDebug,
    (request, response) => {
      try {
        const events = mobileClientLogEvents(request.body || {});
        const result = appendMobileClientLogs({ request, events });
        response.status(200).json({
          success: true,
          written: result.written,
          logFile: result.file,
        });
      } catch (error) {
        response.status(500).json({
          success: false,
          error: error.message,
        });
      }
    }
  );

  app.get(
    `${DEBUG_PREFIX}/mobile-client-log`,
    guardMobileClientDebug,
    (request, response) => {
      const limit = intValue(request.query?.limit, 120, {
        min: 1,
        max: MOBILE_CLIENT_LOG_TAIL_MAX_LINES,
      });
      const file = mobileClientLogPath();
      response.status(200).json({
        success: true,
        logFile: file,
        lines: tailFileLines(file, limit),
      });
    }
  );
}

function debugWebSocketEndpoints(app) {
  if (typeof app.ws !== "function") return;

  app.ws(`${DEBUG_PREFIX}/agent/:uuid`, async (socket, request) => {
    if (!communicationDebugEnabled()) {
      socket.close();
      return;
    }
    const uuid = String(request.params.uuid || "");
    if (!uuid.startsWith("debug-comm-")) {
      socket.close();
      return;
    }

    const mode = String(
      request.query?.scenario ||
        (uuid.includes("waiting")
          ? "waiting"
          : uuid.includes("duplicate")
            ? "duplicate"
            : uuid.includes("close")
              ? "close"
              : "final")
    );
    let seq = Number(request.query?.lastEventSeq || 0);
    const send = async (payload, delayMs = 0) => {
      if (delayMs) await wait(delayMs);
      if (socket.readyState !== 1) return;
      seq += 1;
      socket.send(JSON.stringify({ ...payload, seq }));
    };

    socket.on("message", (message) => {
      const raw = String(message);
      socket.send(
        JSON.stringify({
          type: "debugEcho",
          content: raw,
          seq: (seq += 1),
        })
      );
    });

    await send({ type: "statusResponse", content: "debug-agent-open" }, 5);
    if (mode === "waiting") {
      await send({
        type: "clarifyingQuestion",
        content: {
          questions: [{ id: "q1", question: "Debug clarification?" }],
        },
      });
      return;
    }
    if (mode === "duplicate") {
      const payload = JSON.stringify({
        type: "reportStreamEvent",
        content: {
          type: "textResponseChunk",
          content: "duplicate",
          seq,
        },
        seq,
      });
      socket.send(payload);
      socket.send(payload);
      await send(
        {
          type: "reportStreamEvent",
          content: {
            type: "fullTextResponse",
            content: "debug final",
            chatId: "debug-chat-id",
            publicChatId: "chat_debug",
          },
        },
        5
      );
      return;
    }
    if (mode === "close") {
      socket.close();
      return;
    }
    await send(
      {
        type: "reportStreamEvent",
        content: { type: "textResponseChunk", content: "debug " },
      },
      5
    );
    await send(
      {
        type: "reportStreamEvent",
        content: { type: "textResponseChunk", content: "agent" },
      },
      5
    );
    await send({
      type: "reportStreamEvent",
      content: {
        type: "fullTextResponse",
        content: "debug agent",
        chatId: "debug-chat-id",
        publicChatId: "chat_debug",
        metrics: { outputTps: 1 },
      },
    });
    socket.close();
  });
}

function communicationDebugEndpoints(app) {
  if (!app) return;
  debugJsonEndpoints(app);
  debugUploadEndpoints(app);
  debugBlobEndpoints(app);
  debugStreamEndpoints(app);
  debugMobileClientLogEndpoints(app);
  debugWebSocketEndpoints(app);
}

module.exports = {
  communicationDebugEndpoints,
  communicationDebugEnabled,
  mobileClientDebugEnabled,
};
