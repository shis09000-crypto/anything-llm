const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();
process.env.ATHENA_RUNTIME_ROLE ||= "browser-worker";

const { startOpenTelemetry } = require("./utils/observability");
startOpenTelemetry();
require("./utils/logger")();

const { BrowserWorkerRuntime } = require("./utils/browserPlane/workerRuntime");
const {
  MicroModuleServiceHost,
  installStandaloneShutdown,
} = require("./utils/microModules");

const runtime = new BrowserWorkerRuntime();
const host = new MicroModuleServiceHost({
  manifestId: "browser-worker",
  role: "browser-worker",
  port: Number(process.env.BROWSER_WORKER_PORT || 3031),
  jsonLimit: "2mb",
  enableWebSockets: true,
  readiness: () => runtime.capabilities(),
  onStart: async () => runtime.start(),
  onDrain: async () => runtime.drain(),
  onStop: async () => runtime.drain(),
  registerRoutes: (app) => {
    app.post("/internal/v1/browser/sessions", async (request, response) => {
      response.status(201).json({
        success: true,
        session: await runtime.createSession(request.body || {}),
      });
    });
    app.get(
      "/internal/v1/browser/sessions/:sessionId",
      async (request, response) => {
        const state = runtime.requireSession(
          request.params.sessionId,
          request.query.userRef
        );
        response.json({
          success: true,
          session: runtime.sessionSnapshot(state),
        });
      }
    );
    app.post(
      "/internal/v1/browser/sessions/:sessionId/stream-ticket",
      async (request, response) => {
        response.status(201).json({
          success: true,
          stream: runtime.issueStreamTicket({
            ...(request.body || {}),
            sessionId: request.params.sessionId,
          }),
        });
      }
    );
    app.ws("/browser-stream", async (socket, request) => {
      try {
        const protocol = String(
          request.headers["sec-websocket-protocol"] || ""
        );
        const ticket = protocol
          .split(",")
          .map((value) => value.trim())
          .find((value) => value.startsWith("athena-browser-ticket."))
          ?.slice("athena-browser-ticket.".length);
        await runtime.attachStream(socket, ticket);
      } catch (error) {
        socket.close(
          1011,
          String(error.code || error.message || "browser_stream_failed").slice(
            0,
            120
          )
        );
      }
    });
    app.post(
      "/internal/v1/browser/sessions/:sessionId/actions",
      async (request, response) => {
        response.json({
          success: true,
          result: await runtime.action({
            ...(request.body || {}),
            sessionId: request.params.sessionId,
          }),
        });
      }
    );
    app.post(
      "/internal/v1/browser/sessions/:sessionId/tabs",
      async (request, response) => {
        response.status(201).json({
          success: true,
          session: await runtime.newTab(
            request.params.sessionId,
            request.body?.userRef,
            request.body?.url
          ),
        });
      }
    );
    app.delete(
      "/internal/v1/browser/sessions/:sessionId/tabs/:tabId",
      async (request, response) => {
        response.json({
          success: true,
          session: await runtime.closeTab(
            request.params.sessionId,
            request.body?.userRef,
            request.params.tabId
          ),
        });
      }
    );
    app.get(
      "/internal/v1/browser/sessions/:sessionId/cookies",
      async (request, response) => {
        response.json({
          success: true,
          sites: await runtime.cookieSiteSummary(
            request.params.sessionId,
            request.query.userRef
          ),
        });
      }
    );
    app.post(
      "/internal/v1/browser/sessions/:sessionId/risk-inspection",
      async (request, response) => {
        response.json({
          success: true,
          risk: await runtime.inspectActionRisk({
            ...(request.body || {}),
            sessionId: request.params.sessionId,
          }),
        });
      }
    );
    app.get(
      "/internal/v1/browser/sessions/:sessionId/downloads/:downloadId",
      (request, response) => {
        const download = runtime.downloadFile(
          request.params.sessionId,
          request.query.userRef,
          request.params.downloadId
        );
        response.status(200);
        response.setHeader("Content-Type", download.mimeType);
        response.setHeader("Content-Length", String(download.bytes));
        response.setHeader("X-Athena-Download-Name", download.filename);
        const stream = require("fs").createReadStream(download.filePath);
        stream.once("error", () => response.destroy());
        stream.pipe(response);
      }
    );
    app.delete(
      "/internal/v1/browser/sessions/:sessionId/downloads/:downloadId",
      async (request, response) => {
        response.json({
          success: true,
          result: await runtime.deleteDownload(
            request.params.sessionId,
            request.body?.userRef,
            request.params.downloadId
          ),
        });
      }
    );
    app.post(
      "/internal/v1/browser/sessions/:sessionId/cookies/clear",
      async (request, response) => {
        response.json({
          success: true,
          result: await runtime.clearCookieSite(
            request.params.sessionId,
            request.body?.userRef,
            request.body?.domain
          ),
        });
      }
    );
    app.post(
      "/internal/v1/browser/sessions/:sessionId/close",
      async (request, response) => {
        response.json({
          success: true,
          session: await runtime.closeSession(
            request.params.sessionId,
            request.body || {}
          ),
        });
      }
    );
    app.delete(
      "/internal/v1/browser/profiles/:profileId",
      async (request, response) => {
        response.json({
          success: true,
          result: await runtime.deleteProfile(request.params.profileId, {
            objectRef: request.body?.objectRef || null,
          }),
        });
      }
    );
  },
});

installStandaloneShutdown(host, { name: "BrowserWorker" });
host
  .start()
  .then((snapshot) =>
    console.log(`[BrowserWorker] listening on ${host.port}`, snapshot)
  )
  .catch((error) => {
    console.error("[BrowserWorker] failed to start", error);
    process.exitCode = 1;
  });
