const crypto = require("crypto");
const multer = require("multer");

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

function guardDebug(_request, response, next) {
  if (!communicationDebugEnabled()) return response.sendStatus(404);
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

    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

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
  debugWebSocketEndpoints(app);
}

module.exports = {
  communicationDebugEndpoints,
  communicationDebugEnabled,
};
