const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();
process.env.ATHENA_RUNTIME_ROLE ||= "browser-plane";

const { startOpenTelemetry } = require("./utils/observability");
startOpenTelemetry();
require("./utils/logger")();

const { browserPlaneRuntime } = require("./utils/browserPlane/runtime");
const {
  MicroModuleServiceHost,
  installStandaloneShutdown,
  secureDatabaseStart,
} = require("./utils/microModules");

const host = new MicroModuleServiceHost({
  manifestId: "browser-plane",
  role: "browser-plane",
  port: Number(process.env.BROWSER_PLANE_PORT || 3030),
  jsonLimit: "2mb",
  readiness: () => browserPlaneRuntime.snapshot(),
  onStart: async () => {
    await secureDatabaseStart("browser-plane");
    browserPlaneRuntime.start();
  },
  onDrain: async () => browserPlaneRuntime.drain(),
  registerRoutes: (app) => {
    app.post("/internal/v1/browser/dispatch", async (request, response) => {
      const operation = String(request.body?.operation || "");
      const input = request.body?.input || {};
      const handlers = {
        createSession: (payload) => browserPlaneRuntime.createSession(payload),
        session: (payload) => browserPlaneRuntime.session(payload),
        streamTicket: (payload) => browserPlaneRuntime.streamTicket(payload),
        action: (payload) => browserPlaneRuntime.action(payload),
        newTab: (payload) => browserPlaneRuntime.newTab(payload),
        closeTab: (payload) => browserPlaneRuntime.closeTab(payload),
        cookies: (payload) => browserPlaneRuntime.cookies(payload),
        clearCookies: (payload) => browserPlaneRuntime.clearCookies(payload),
        closeSession: (payload) => browserPlaneRuntime.closeSession(payload),
        deleteProfile: (payload) => browserPlaneRuntime.deleteProfile(payload),
        listWorkspaces: (payload) =>
          browserPlaneRuntime.listWorkspaces(payload.userId),
        saveWorkspace: (payload) =>
          browserPlaneRuntime.saveWorkspace(
            payload.userId,
            payload.input || {}
          ),
        listHistory: (payload) =>
          browserPlaneRuntime.listHistory(payload.userId),
        listBookmarks: (payload) =>
          browserPlaneRuntime.listBookmarks(payload.userId),
        addBookmark: (payload) =>
          browserPlaneRuntime.addBookmark(payload.userId, payload.input || {}),
        egressStatus: (payload) => browserPlaneRuntime.egressStatus(payload),
        profileRoute: (payload) => browserPlaneRuntime.profileRoute(payload),
        setProfileRoute: (payload) =>
          browserPlaneRuntime.setProfileRoute(payload),
        enrollEgress: (payload) => browserPlaneRuntime.enrollEgress(payload),
        renewEgress: (payload) => browserPlaneRuntime.renewEgress(payload),
        revokeEgress: (payload) => browserPlaneRuntime.revokeEgress(payload),
        openSystemChrome: (payload) =>
          browserPlaneRuntime.openSystemChrome(payload),
        confirmProfileRoute: (payload) =>
          browserPlaneRuntime.confirmProfileRoute(payload),
        registerNode: (payload) => browserPlaneRuntime.registerNode(payload),
        listNodes: (payload) =>
          browserPlaneRuntime.nodesForUser(payload.userId),
        status: () => browserPlaneRuntime.snapshot(),
      };
      const handler = handlers[operation];
      if (!handler)
        return response
          .status(400)
          .json({ success: false, error: "browser_plane_operation_unknown" });
      response.json({ success: true, result: await handler(input) });
    });
    app.post("/internal/v1/browser/sessions", async (request, response) => {
      response.status(201).json({
        success: true,
        session: await browserPlaneRuntime.createSession(request.body || {}),
      });
    });
    app.get(
      "/internal/v1/browser/sessions/:sessionId",
      async (request, response) => {
        response.json({
          success: true,
          session: await browserPlaneRuntime.session({
            userId: request.query.userId,
            sessionId: request.params.sessionId,
          }),
        });
      }
    );
    app.post(
      "/internal/v1/browser/sessions/:sessionId/actions",
      async (request, response) => {
        response.json({
          success: true,
          result: await browserPlaneRuntime.action({
            ...(request.body || {}),
            sessionId: request.params.sessionId,
          }),
        });
      }
    );
    app.post(
      "/internal/v1/browser/nodes/heartbeat",
      async (request, response) => {
        response.json({
          success: true,
          node: browserPlaneRuntime.registerNode(request.body || {}),
        });
      }
    );
    app.get("/internal/v1/browser/nodes", async (request, response) => {
      response.json({
        success: true,
        nodes: browserPlaneRuntime.nodesForUser(request.query.userId),
      });
    });
  },
});

installStandaloneShutdown(host, { name: "BrowserPlane" });
host
  .start()
  .then((snapshot) =>
    console.log(`[BrowserPlane] listening on ${host.port}`, snapshot)
  )
  .catch((error) => {
    console.error("[BrowserPlane] failed to start", error);
    process.exitCode = 1;
  });
