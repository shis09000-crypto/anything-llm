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
  finalizedTurnPersister,
  hotTurnBuffer,
} = require("./utils/chats/hotTurnBuffer");
const {
  configuredPromptTimeZone,
} = require("./utils/chats/currentDateTimeContext");
const {
  publicReadiness: threadMemoryReadiness,
  registerThreadMemoryRoutes,
  threadMemoryKeyCustodySelfTest,
} = require("./utils/chats/threadMemoryRuntime");
const {
  maybeEnqueueTitleGenerationAfterChat,
  refreshRecentThreadTitles,
} = require("./utils/chats/threadTitleGeneration");
const {
  subscribeToWorkspaceSyncEvents,
} = require("./utils/chats/workspaceSyncEvents");
const {
  ThreeDSessionMemoryRuntime,
  registerThreeDSessionMemoryRoutes,
} = require("./utils/chats/threeDSessionMemory");
const { startFastLaneServer } = require("./utils/athena3dCenter/fastLane");

const role = "chat-runtime";
const port = Number(process.env.CHAT_RUNTIME_PORT || 3016);
const drainTimeoutMs = Number(
  process.env.ATHENA_RUNTIME_DRAIN_TIMEOUT_MS || 120_000
);
let unsubscribeTitleFinalization = null;
let threeDFastLane = null;
const threeDSessionMemoryRuntime = new ThreeDSessionMemoryRuntime();

async function dispatchThreeDFastLane(operation, payload) {
  switch (operation) {
    case "memory.session.create":
      return threeDSessionMemoryRuntime.createSession(payload);
    case "memory.context.resolve":
      return threeDSessionMemoryRuntime.contextResolve(payload);
    case "memory.context.prepare":
      return threeDSessionMemoryRuntime.contextPrepare(payload);
    case "memory.turn.commit":
      return threeDSessionMemoryRuntime.commitTurn(payload);
    case "memory.status":
      return threeDSessionMemoryRuntime.status(payload);
    case "memory.session.delete":
      return threeDSessionMemoryRuntime.deleteSession(payload);
    case "memory.maintenance":
      return threeDSessionMemoryRuntime.maintain(payload);
    case "memory.long_term.archive.prepare":
      return threeDSessionMemoryRuntime.archiveLongTerm(payload);
    case "memory.long_term.finalize.commit":
      return threeDSessionMemoryRuntime.finalizeLongTerm(payload);
    case "memory.long_term.context.resolve":
      return threeDSessionMemoryRuntime.longTermContext(payload);
    case "memory.long_term.recall.freeze":
      return threeDSessionMemoryRuntime.freezeLongTermRecall(payload);
    case "memory.long_term.status":
      return threeDSessionMemoryRuntime.longTermStatus(payload);
    case "memory.long_term.objects.list":
      return threeDSessionMemoryRuntime.listLongTermObjects(payload);
    case "memory.long_term.session.delete":
      return threeDSessionMemoryRuntime.deleteLongTermSession(payload);
    case "memory.long_term.profile.reset":
      return threeDSessionMemoryRuntime.resetLongTermProfile(payload);
    case "memory.long_term.reconsolidate":
      return threeDSessionMemoryRuntime.reconsolidateLongTerm(payload);
    case "memory.long_term.maintenance":
      return threeDSessionMemoryRuntime.maintain(payload);
    default: {
      const error = new Error("athena_3d_fast_lane_operation_unknown");
      error.code = "athena_3d_fast_lane_operation_unknown";
      error.httpStatus = 404;
      throw error;
    }
  }
}

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
      ready:
        streams.ready !== false &&
        threadMemory.ready === true &&
        threeDSessionMemoryRuntime.snapshot().ready === true,
      threadMemory,
      threeDSessionMemory: threeDSessionMemoryRuntime.snapshot(),
      threeDFastLane: threeDFastLane
        ? {
            ready: true,
            protocol: threeDFastLane.protocol,
            host: threeDFastLane.host,
            port: threeDFastLane.port,
          }
        : { ready: false },
    };
  },
  onStart: async () => {
    await secureDatabaseStart(role, threadMemoryKeyCustodySelfTest);
    if (process.env.ATHENA_3D_FAST_LANE_ENABLED !== "false")
      threeDFastLane = await startFastLaneServer({
        role,
        port: Number(process.env.ATHENA_3D_MEMORY_FAST_LANE_PORT || 3116),
        host: process.env.ATHENA_3D_FAST_LANE_HOST || "127.0.0.1",
        handler: dispatchThreeDFastLane,
      });
    threeDSessionMemoryRuntime.start();
    unsubscribeTitleFinalization = subscribeToWorkspaceSyncEvents((event) => {
      if (
        event.type !== "chat_finalized" ||
        event.mutationKind !== "agent_finalized" ||
        !event.threadId
      )
        return;
      void maybeEnqueueTitleGenerationAfterChat({
        workspaceId: event.workspaceId,
        threadId: event.threadId,
        userId: event.userId ?? null,
        include: true,
      });
    });
  },
  onDrain: async () => {
    threeDSessionMemoryRuntime.stop();
    await threeDFastLane?.close?.();
    threeDFastLane = null;
    unsubscribeTitleFinalization?.();
    unsubscribeTitleFinalization = null;
    return await chatStreamRunManager.drain({
      timeoutMs: drainTimeoutMs,
    });
  },
  onStop: async () => {
    await threeDFastLane?.close?.();
    threeDFastLane = null;
  },
  registerRoutes: (app) => {
    registerCompatibleApi(app, chatEndpoints);
    registerThreadMemoryRoutes(app);
    app.use(
      "/internal/v1/3d-center/memory",
      require("express").json({ limit: "10mb" })
    );
    registerThreeDSessionMemoryRoutes(app, threeDSessionMemoryRuntime);
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
    "/internal/v1/3d-center/memory/sessions/create":
      "3d-center.memory.session.create",
    "/internal/v1/3d-center/memory/sessions/context/resolve":
      "3d-center.memory.context.resolve",
    "/internal/v1/3d-center/memory/sessions/turns/commit":
      "3d-center.memory.turn.commit",
    "/internal/v1/3d-center/memory/sessions/status": "3d-center.memory.status",
    "/internal/v1/3d-center/memory/sessions/delete":
      "3d-center.memory.session.delete",
    "/internal/v1/3d-center/memory/maintenance": "3d-center.memory.maintenance",
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
