const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();
process.env.ATHENA_RUNTIME_ROLE ||= "chat-runtime";

const { startOpenTelemetry } = require("./utils/observability");
startOpenTelemetry();
require("./utils/logger")();

const { ensureWebCrypto } = require("./utils/security/webCrypto");
ensureWebCrypto();
const {
  assertProductionSecurityConfig,
} = require("./utils/security/startupValidation");
assertProductionSecurityConfig();

const { chatEndpoints } = require("./endpoints/chat");
const {
  MicroModuleServiceHost,
  installStandaloneShutdown,
  registerCompatibleApi,
  secureDatabaseStart,
} = require("./utils/microModules");
const { chatStreamRunManager } = require("./utils/chats/chatStreamRuns");

const role = "chat-runtime";
const port = Number(process.env.CHAT_RUNTIME_PORT || 3016);
const drainTimeoutMs = Number(
  process.env.ATHENA_RUNTIME_DRAIN_TIMEOUT_MS || 120_000
);

const host = new MicroModuleServiceHost({
  manifestId: "chat-runtime",
  role,
  port,
  parseJson: false,
  readiness: () => chatStreamRunManager.snapshot(),
  onStart: () => secureDatabaseStart(role),
  onDrain: () =>
    chatStreamRunManager.drain({
      timeoutMs: drainTimeoutMs,
    }),
  registerRoutes: (app) => {
    registerCompatibleApi(app, chatEndpoints);
    app.get(
      "/internal/v1/chat/runs/:clientTurnId",
      async (request, response) => {
        const run = await chatStreamRunManager.state({
          clientTurnId: request.params.clientTurnId,
          workspaceId: Number(request.query.workspaceId),
          threadId: request.query.threadId
            ? Number(request.query.threadId)
            : null,
          userId: request.query.userId ? Number(request.query.userId) : null,
        });
        response.status(run ? 200 : 404).json({
          success: Boolean(run),
          run,
          ...(!run ? { error: "chat_stream_run_not_found" } : {}),
        });
      }
    );
  },
});

installStandaloneShutdown(host, { name: "ChatRuntime" });
host
  .start()
  .then((snapshot) =>
    console.log(`[ChatRuntime] listening on ${host.port}`, snapshot)
  )
  .catch((error) => {
    console.error("[ChatRuntime] failed to start", error);
    process.exitCode = 1;
  });
