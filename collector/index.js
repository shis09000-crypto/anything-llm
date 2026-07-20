const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });
const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();

require("./utils/logger")();
const express = require("express");
const cors = require("cors");
const path = require("path");
const { ACCEPTED_MIMES } = require("./utils/constants");
const { reqBody } = require("./utils/http");
const { processSingleFile } = require("./processSingleFile");
const { processLink, getLinkText } = require("./processLink");
const { wipeCollectorStorage } = require("./utils/files");
const extensions = require("./extensions");
const { processRawText } = require("./processRawText");
const { verifyPayloadIntegrity } = require("./middleware/verifyIntegrity");
const { httpLogger } = require("./middleware/httpLogger");
const { requestBodyPolicy } = require("./middleware/requestBodyPolicy");
const {
  collectorTaskGuard,
  isCollectorProcessingRoute,
  taskStats,
} = require("./utils/taskContext");
const { assertCollectorRuntimeSecurity } = require("./utils/runtimeSecurity");
const app = express();
let ready = false;
let httpServer = null;

// Only log HTTP requests in development mode and if the ENABLE_HTTP_LOGGER environment variable is set to true
if (
  process.env.NODE_ENV === "development" &&
  !!process.env.ENABLE_HTTP_LOGGER
) {
  app.use(
    httpLogger({
      enableTimestamps: !!process.env.ENABLE_HTTP_LOGGER_TIMESTAMPS,
    })
  );
}
app.use(cors({ origin: true }));
app.use((request, response, next) => {
  if (!isCollectorProcessingRoute(request)) return next();
  return collectorTaskGuard(request, response, next);
});
app.use(requestBodyPolicy);

app.post(
  "/process",
  [verifyPayloadIntegrity],
  async function (request, response) {
    const { filename, options = {}, metadata = {} } = reqBody(request);
    try {
      const targetFilename = path
        .normalize(filename)
        .replace(/^(\.\.(\/|\\|$))+/, "");
      const {
        success,
        reason,
        documents = [],
      } = await processSingleFile(targetFilename, options, metadata);
      response
        .status(200)
        .json({ filename: targetFilename, success, reason, documents });
    } catch (e) {
      console.error(e);
      response.status(200).json({
        filename: filename,
        success: false,
        reason: "A processing error occurred.",
        documents: [],
      });
    }
    return;
  }
);

app.post(
  "/parse",
  [verifyPayloadIntegrity],
  async function (request, response) {
    const { filename, options = {} } = reqBody(request);
    try {
      const targetFilename = path
        .normalize(filename)
        .replace(/^(\.\.(\/|\\|$))+/, "");
      const {
        success,
        reason,
        documents = [],
      } = await processSingleFile(
        targetFilename,
        {
          ...options,
          parseOnly: true,
          absolutePath: options.absolutePath || null,
        },
        {
          title: options.displayName || path.basename(targetFilename),
        }
      );
      response
        .status(200)
        .json({ filename: targetFilename, success, reason, documents });
    } catch (e) {
      console.error(e);
      response.status(200).json({
        filename: filename,
        success: false,
        reason: "A processing error occurred.",
        documents: [],
      });
    }
    return;
  }
);

app.post(
  "/process-link",
  [verifyPayloadIntegrity],
  async function (request, response) {
    const { link, scraperHeaders = {}, metadata = {} } = reqBody(request);
    try {
      const {
        success,
        reason,
        documents = [],
      } = await processLink(link, scraperHeaders, metadata);
      response.status(200).json({ url: link, success, reason, documents });
    } catch (e) {
      console.error(e);
      if (e?.code === "collector_destination_forbidden")
        return response.status(403).json({
          success: false,
          error: "collector_destination_forbidden",
          url: link,
          documents: [],
        });
      response.status(200).json({
        url: link,
        success: false,
        reason: "A processing error occurred.",
        documents: [],
      });
    }
    return;
  }
);

app.post(
  "/util/get-link",
  [verifyPayloadIntegrity],
  async function (request, response) {
    const { link, captureAs = "text" } = reqBody(request);
    try {
      const { success, content = null } = await getLinkText(link, captureAs);
      response.status(200).json({ url: link, success, content });
    } catch (e) {
      console.error(e);
      if (e?.code === "collector_destination_forbidden")
        return response.status(403).json({
          success: false,
          error: "collector_destination_forbidden",
          url: link,
          content: null,
        });
      response.status(200).json({
        url: link,
        success: false,
        content: null,
      });
    }
    return;
  }
);

app.post(
  "/process-raw-text",
  [verifyPayloadIntegrity],
  async function (request, response) {
    const { textContent, metadata } = reqBody(request);
    try {
      const {
        success,
        reason,
        documents = [],
      } = await processRawText(textContent, metadata);
      response
        .status(200)
        .json({ filename: metadata.title, success, reason, documents });
    } catch (e) {
      console.error(e);
      response.status(200).json({
        filename: metadata?.title || "Unknown-doc.txt",
        success: false,
        reason: "A processing error occurred.",
        documents: [],
      });
    }
    return;
  }
);

extensions(app);

app.get("/accepts", function (_, response) {
  response.status(200).json(ACCEPTED_MIMES);
});

app.get("/health", function (_, response) {
  response.status(ready ? 200 : 503).json({
    ready,
    tasks: taskStats(),
  });
});

app.all("*", function (_, response) {
  response.sendStatus(200);
});

app.use((error, _request, response, _next) => {
  console.error("[Collector] Request failed", error.message);
  if (response.headersSent) return;
  response.status(400).json({ success: false, error: "collector_bad_request" });
});

async function start() {
  await assertCollectorRuntimeSecurity();
  await wipeCollectorStorage();
  httpServer = app.listen(process.env.COLLECTOR_PORT || 8888, () => {
    ready = true;
    console.log(
      `Document processor app listening on port ${
        process.env.COLLECTOR_PORT || 8888
      }`
    );
  });
  httpServer.on("error", function (_) {
    process.once("SIGUSR2", function () {
      process.kill(process.pid, "SIGUSR2");
    });
    process.on("SIGINT", function () {
      process.kill(process.pid, "SIGINT");
    });
  });
}

async function shutdown(signal) {
  ready = false;
  console.log(`[Collector] ${signal} received; draining requests.`);
  const timeout = setTimeout(() => process.exit(1), 30_000);
  timeout.unref();
  if (httpServer)
    await new Promise((resolve) => httpServer.close(() => resolve()));
  clearTimeout(timeout);
  process.exit(0);
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

start().catch((error) => {
  ready = false;
  console.error(`[Collector] Startup failed: ${error.message}`);
  process.exitCode = 1;
});

module.exports = { app, start };
