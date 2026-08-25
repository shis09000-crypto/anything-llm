const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();
process.env.ATHENA_RUNTIME_ROLE ||= "character-performance-runtime";

const { startOpenTelemetry } = require("./utils/observability");
startOpenTelemetry();
require("./utils/logger")();

const {
  MicroModuleServiceHost,
  installStandaloneShutdown,
  secureDatabaseStart,
} = require("./utils/microModules");
const {
  CharacterPerformanceRuntime,
  normalizeScope,
} = require("./utils/characterPerformance");

const role = "character-performance-runtime";
const port = Number(process.env.CHARACTER_PERFORMANCE_RUNTIME_PORT || 3042);
const runtime = new CharacterPerformanceRuntime();

function asyncRoute(handler) {
  return async (request, response) => {
    try {
      await handler(request, response);
    } catch (error) {
      response.status(Number(error.httpStatus || 500)).json({
        success: false,
        error: error.code || error.message || "character_performance_failed",
        details: error.details || undefined,
      });
    }
  };
}

function requestScope(request) {
  return request.body?.scope || request.body?.athena || request.query || {};
}

const internalRouteCapabilities = {
  "GET /internal/v1/character-performance/packs/:packId":
    "character-performance.packs.retrieve",
  "/internal/v1/character-performance/sessions":
    "character-performance.sessions.create",
  "GET /internal/v1/character-performance/sessions/:sessionId":
    "character-performance.sessions.retrieve",
  "GET /internal/v1/character-performance/sessions/:sessionId/.websocket":
    "character-performance.sessions.retrieve",
  "GET /internal/v1/character-performance/sessions/:sessionId/scope":
    "character-performance.sessions.resolve-scope",
  "/internal/v1/character-performance/sessions/:sessionId/link":
    "character-performance.sessions.link",
  "/internal/v1/character-performance/sessions/:sessionId/plans":
    "character-performance.plans.compile",
  "GET /internal/v1/character-performance/sessions/:sessionId/events":
    "character-performance.events.retrieve",
  "/internal/v1/character-performance/sessions/:sessionId/execution-feedback":
    "character-performance.feedback.create",
  "/internal/v1/character-performance/sessions/:sessionId/cancel":
    "character-performance.sessions.cancel",
};

const host = new MicroModuleServiceHost({
  manifestId: "character-performance-runtime",
  role,
  port,
  jsonLimit: "4mb",
  enableWebSockets: true,
  readiness: () => runtime.snapshot(),
  onStart: async () => {
    await secureDatabaseStart(role);
  },
  internalRouteCapabilities,
  registerRoutes: (app) => {
    app.get(
      "/internal/v1/character-performance/sessions/:sessionId/scope",
      asyncRoute(async (request, response) => {
        response.json({
          success: true,
          scope: await runtime.resolveScope(
            request.params.sessionId,
            request.query.owner_user_id ?? null
          ),
        });
      })
    );
    app.get(
      "/internal/v1/character-performance/packs/:packId",
      asyncRoute(async (request, response) => {
        response.json({
          success: true,
          pack: runtime.pack(request.params.packId),
        });
      })
    );
    app.post(
      "/internal/v1/character-performance/sessions",
      asyncRoute(async (request, response) => {
        response.status(201).json({
          success: true,
          session: await runtime.createSession(request.body || {}),
        });
      })
    );
    app.get(
      "/internal/v1/character-performance/sessions/:sessionId",
      asyncRoute(async (request, response) => {
        response.json({
          success: true,
          session: await runtime.retrieve(
            request.params.sessionId,
            requestScope(request)
          ),
        });
      })
    );
    app.post(
      "/internal/v1/character-performance/sessions/:sessionId/link",
      asyncRoute(async (request, response) => {
        response.json({
          success: true,
          session: await runtime.link(
            request.params.sessionId,
            request.body || {}
          ),
        });
      })
    );
    app.post(
      "/internal/v1/character-performance/sessions/:sessionId/plans",
      asyncRoute(async (request, response) => {
        response.status(201).json({
          success: true,
          plan: await runtime.submitPlan(
            request.params.sessionId,
            request.body || {}
          ),
        });
      })
    );
    app.get(
      "/internal/v1/character-performance/sessions/:sessionId/events",
      asyncRoute(async (request, response) => {
        response.json({
          success: true,
          events: await runtime.events(
            request.params.sessionId,
            request.query.after_sequence ?? -1,
            requestScope(request)
          ),
        });
      })
    );
    app.post(
      "/internal/v1/character-performance/sessions/:sessionId/execution-feedback",
      asyncRoute(async (request, response) => {
        response.json({
          success: true,
          ...(await runtime.feedback(
            request.params.sessionId,
            request.body || {}
          )),
        });
      })
    );
    app.post(
      "/internal/v1/character-performance/sessions/:sessionId/cancel",
      asyncRoute(async (request, response) => {
        response.json({
          success: true,
          session: await runtime.cancel(
            request.params.sessionId,
            request.body || {}
          ),
        });
      })
    );
    app.ws(
      "/internal/v1/character-performance/sessions/:sessionId",
      (socket, request) => {
        socket.on("message", async (raw) => {
          try {
            const message = JSON.parse(raw.toString("utf8"));
            const scope = normalizeScope(message.scope || message.athena);
            let payload;
            if (message.type === "character.performance.events")
              payload = await runtime.events(
                request.params.sessionId,
                message.after_sequence ?? -1,
                scope
              );
            else if (message.type === "character.execution.feedback")
              payload = await runtime.feedback(
                request.params.sessionId,
                message
              );
            else if (message.type === "character.performance.cancel")
              payload = await runtime.cancel(request.params.sessionId, message);
            else throw new Error("character_performance_message_invalid");
            for (const entry of Array.isArray(payload) ? payload : [payload])
              socket.send(JSON.stringify(entry));
          } catch (error) {
            socket.send(
              JSON.stringify({
                type: "character.performance.error",
                code: error.code || error.message,
              })
            );
          }
        });
      }
    );
  },
});

installStandaloneShutdown(host, { name: "CharacterPerformanceRuntime" });
host
  .start()
  .then((snapshot) =>
    console.log(
      `[CharacterPerformanceRuntime] listening on ${host.port}`,
      snapshot
    )
  )
  .catch((error) => {
    console.error("[CharacterPerformanceRuntime] failed to start", error);
    process.exitCode = 1;
  });
