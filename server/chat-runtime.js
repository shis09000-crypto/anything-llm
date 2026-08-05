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
const {
  publicReadiness: threadMemoryReadiness,
  registerThreadMemoryRoutes,
  threadMemoryKeyCustodySelfTest,
} = require("./utils/chats/threadMemoryRuntime");
const {
  registerAgentTurnPersistenceRoutes,
} = require("./utils/chats/agentTurnPersistenceRuntime");
const {
  maybeEnqueueTitleGenerationAfterChat,
  refreshRecentThreadTitles,
} = require("./utils/chats/threadTitleGeneration");

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
  readiness: () => {
    const streams = chatStreamRunManager.snapshot();
    const threadMemory = threadMemoryReadiness();
    return {
      ...streams,
      ready: streams.ready !== false && threadMemory.ready === true,
      threadMemory,
    };
  },
  onStart: () => secureDatabaseStart(role, threadMemoryKeyCustodySelfTest),
  onDrain: () =>
    chatStreamRunManager.drain({
      timeoutMs: drainTimeoutMs,
    }),
  registerRoutes: (app) => {
    registerCompatibleApi(app, chatEndpoints);
    registerThreadMemoryRoutes(app);
    registerAgentTurnPersistenceRoutes(app);
    app.use(
      "/internal/v1/chat/thread-title",
      require("express").json({ limit: "64kb" })
    );
    app.post(
      "/internal/v1/chat/thread-title/generate",
      async (request, response) => {
        const result = await maybeEnqueueTitleGenerationAfterChat({
          workspaceId: request.body?.workspaceId,
          threadId: request.body?.threadId,
          userId: request.body?.userId ?? null,
          include: request.body?.include !== false,
          apiSessionId: request.body?.apiSessionId ?? null,
        });
        response.json({ success: true, result: result || null });
      }
    );
    app.post(
      "/internal/v1/chat/thread-title/reconcile",
      async (request, response) => {
        const result = await refreshRecentThreadTitles({
          pageSize: Math.min(
            250,
            Math.max(1, Number(request.body?.pageSize || 100))
          ),
          waitForIdle: request.body?.waitForIdle === true,
        });
        response.json({ success: true, result });
      }
    );
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
  internalRouteCapabilities: {
    "/internal/v1/chat/memory/status": "chat.memory.status",
    "/internal/v1/chat/memory/compact": "chat.memory.compact",
    "/internal/v1/chat/memory/context/resolve": "chat.memory.context.resolve",
    "/internal/v1/chat/agent-turns/reserve": "chat.agent-turn.reserve",
    "/internal/v1/chat/agent-turns/finalize": "chat.agent-turn.finalize",
    "/internal/v1/chat/thread-title/generate": "chat.thread-title.generate",
    "/internal/v1/chat/thread-title/reconcile": "chat.thread-title.reconcile",
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
