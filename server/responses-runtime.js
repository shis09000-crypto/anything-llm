const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();
process.env.ATHENA_RUNTIME_ROLE ||= "responses-runtime";

const { startOpenTelemetry } = require("./utils/observability");
startOpenTelemetry();
require("./utils/logger")();

const { ensureWebCrypto } = require("./utils/security/webCrypto");
ensureWebCrypto();
const {
  assertProductionSecurityConfig,
} = require("./utils/security/startupValidation");
assertProductionSecurityConfig();

const {
  MicroModuleServiceHost,
  installStandaloneShutdown,
  requestInternalService,
  secureDatabaseStart,
} = require("./utils/microModules");
const { ResponsesRuntime } = require("./utils/responsesRuntime/runtime");
const { protect, unprotect } = require("./utils/responsesRuntime/repository");

const role = "responses-runtime";
const port = Number(process.env.RESPONSES_RUNTIME_PORT || 3034);
const runtime = new ResponsesRuntime();

async function dependencySelfTest() {
  if (process.env.ATHENA_KEY_CUSTODY_CUTOVER !== "true") {
    const error = new Error("responses_remote_key_custody_required");
    error.code = "responses_remote_key_custody_required";
    throw error;
  }
  const probeResource = `responses-runtime:self-test:${Date.now()}`;
  const ciphertext = await protect({ ok: true }, probeResource);
  const plaintext = await unprotect(ciphertext, probeResource);
  if (plaintext?.ok !== true)
    throw new Error("responses_key_custody_self_test_failed");
  const modelGatewayUrl = String(
    process.env.ATHENA_MODEL_GATEWAY_URL || ""
  ).replace(/\/+$/, "");
  if (!modelGatewayUrl) throw new Error("model_gateway_url_missing");
  const capability = await requestInternalService({
    callerRole: role,
    targetModule: "model-gateway",
    capability: "model.responses.capabilities",
    contractVersion: "1.0",
    method: "GET",
    url: `${modelGatewayUrl}/internal/v1/models/responses/capabilities`,
    timeoutMs: 10_000,
  });
  if (capability?.ready !== true)
    throw new Error("model_responses_capability_unavailable");
}

function asyncRoute(handler) {
  return async (request, response) => {
    try {
      await handler(request, response);
    } catch (error) {
      if (response.headersSent) {
        if (!response.destroyed)
          response.end(
            `${JSON.stringify({ error: error.code || error.message })}\n`
          );
        return;
      }
      response.status(Number(error.httpStatus || 500)).json({
        success: false,
        error: error.code || error.message || "responses_runtime_failed",
      });
    }
  };
}

function runtimeBody(request) {
  return {
    ...(request.body || {}),
    athena: {
      ...(request.body?.athena || {}),
      idempotencyKey:
        String(request.headers["idempotency-key"] || "").trim() ||
        request.body?.athena?.idempotencyKey ||
        null,
    },
  };
}

function requestAthena(request) {
  const source = request.body?.athena || request.query || {};
  return {
    workspaceId: source.workspaceId,
    threadId: source.threadId,
    userId: source.userId,
    chatRunId: source.chatRunId,
    agentRunId: source.agentRunId,
  };
}

const internalRouteCapabilities = {
  "/internal/v1/responses": "responses.create",
  "/internal/v1/responses/stream": "responses.stream",
  "GET /internal/v1/responses/:responseId": "responses.retrieve",
  "GET /internal/v1/responses/agent-runs/:agentRunId/status":
    "responses.agent-run.status",
  "DELETE /internal/v1/responses/:responseId": "responses.delete",
  "/internal/v1/responses/:responseId/cancel": "responses.cancel",
  "/internal/v1/responses/:responseId/input-items":
    "responses.input-items.list",
  "/internal/v1/responses/conversations": "responses.conversation.create",
  "GET /internal/v1/responses/conversations/:conversationId":
    "responses.conversation.retrieve",
  "DELETE /internal/v1/responses/conversations/:conversationId":
    "responses.conversation.delete",
  "/internal/v1/responses/conversations/:conversationId/items":
    "responses.conversation.items",
  "/internal/v1/responses/compact": "responses.compact",
  "/internal/v1/responses/capabilities": "responses.capabilities",
  "/internal/v1/responses/background/claim": "responses.background.claim",
  "/internal/v1/responses/background/:responseId/execute":
    "responses.background.execute",
  "/internal/v1/responses/maintenance": "responses.maintenance",
};

const host = new MicroModuleServiceHost({
  manifestId: "responses-runtime",
  role,
  port,
  jsonLimit: "2mb",
  readiness: () => runtime.snapshot(),
  onStart: async () => {
    await secureDatabaseStart(role);
    await dependencySelfTest();
  },
  onDrain: () => runtime.stop(),
  internalRouteCapabilities,
  registerRoutes: (app) => {
    app.get("/internal/v1/responses/capabilities", (_request, response) => {
      response.json({
        success: true,
        schemaVersion: "athena.responses.capabilities.v1",
        models: ["deepseek-v4-flash"],
        protocols: ["responses", "chat_completions"],
        state: {
          response: true,
          conversation: true,
          previousResponseId: true,
          background: true,
          cancel: true,
          compaction: true,
        },
      });
    });
    app.post(
      "/internal/v1/responses",
      asyncRoute(async (request, response) => {
        response.json({
          success: true,
          response: await runtime.complete(runtimeBody(request)),
        });
      })
    );
    app.post(
      "/internal/v1/responses/stream",
      asyncRoute(async (request, response) => {
        response.status(200);
        response.setHeader("Content-Type", "application/x-ndjson");
        response.setHeader("X-Accel-Buffering", "no");
        response.flushHeaders?.();
        for await (const event of runtime.stream(runtimeBody(request))) {
          if (response.destroyed) break;
          response.write(`${JSON.stringify({ event })}\n`);
        }
        if (!response.destroyed)
          response.end(`${JSON.stringify({ end: true })}\n`);
      })
    );
    app.get(
      "/internal/v1/responses/agent-runs/:agentRunId/status",
      asyncRoute(async (request, response) => {
        const status = await runtime.agentRunStatus(request.params.agentRunId);
        response.status(status ? 200 : 404).json({
          success: Boolean(status),
          response: status,
          ...(!status ? { error: "response_not_found" } : {}),
        });
      })
    );
    app.get(
      "/internal/v1/responses/:responseId",
      asyncRoute(async (request, response) => {
        response.json({
          success: true,
          response: await runtime.retrieve(
            request.params.responseId,
            requestAthena(request)
          ),
        });
      })
    );
    app.post(
      "/internal/v1/responses/:responseId/cancel",
      asyncRoute(async (request, response) => {
        response.json({
          success: true,
          response: await runtime.cancel(
            request.params.responseId,
            requestAthena(request)
          ),
        });
      })
    );
    app.delete(
      "/internal/v1/responses/:responseId",
      asyncRoute(async (request, response) => {
        response.json({
          success: true,
          ...(await runtime.deleteResponse(
            request.params.responseId,
            requestAthena(request)
          )),
        });
      })
    );
    app.get(
      "/internal/v1/responses/:responseId/input-items",
      asyncRoute(async (request, response) => {
        const itemResponse = await runtime.retrieve(
          request.params.responseId,
          requestAthena(request)
        );
        if (!itemResponse.conversation)
          return response.json({ success: true, items: [] });
        response.json({
          success: true,
          items: (await runtime.repository.listItems(request.params.responseId))
            .map(({ payloadCiphertext: _ciphertext, ...item }) => item)
            .filter((item) => item.sequence < 10_000),
        });
      })
    );
    app.post(
      "/internal/v1/responses/conversations",
      asyncRoute(async (request, response) => {
        response.json({
          success: true,
          conversation: await runtime.createConversation(
            request.body?.athena || {}
          ),
        });
      })
    );
    app.get(
      "/internal/v1/responses/conversations/:conversationId",
      asyncRoute(async (request, response) => {
        response.json({
          success: true,
          conversation: await runtime.retrieveConversation(
            request.params.conversationId,
            requestAthena(request)
          ),
        });
      })
    );
    app.delete(
      "/internal/v1/responses/conversations/:conversationId",
      asyncRoute(async (request, response) => {
        response.json({
          success: true,
          ...(await runtime.deleteConversation(
            request.params.conversationId,
            requestAthena(request)
          )),
        });
      })
    );
    app.get(
      "/internal/v1/responses/conversations/:conversationId/items",
      asyncRoute(async (request, response) => {
        response.json({
          success: true,
          items: await runtime.conversationItems(
            request.params.conversationId,
            requestAthena(request)
          ),
        });
      })
    );
    app.post(
      "/internal/v1/responses/compact",
      asyncRoute(async (request, response) => {
        response.json({
          success: true,
          compaction: await runtime.compact({
            ...(request.body || {}),
            athena: requestAthena(request),
          }),
        });
      })
    );
    app.post(
      "/internal/v1/responses/background/claim",
      asyncRoute(async (request, response) => {
        response.json({
          success: true,
          response: await runtime.claimBackground(
            request.body?.ownerId,
            Number(request.body?.leaseMs || 30_000)
          ),
        });
      })
    );
    app.post(
      "/internal/v1/responses/background/:responseId/execute",
      asyncRoute(async (request, response) => {
        response.json({
          success: true,
          response: await runtime.executeQueued(request.params.responseId),
        });
      })
    );
    app.post(
      "/internal/v1/responses/maintenance",
      asyncRoute(async (request, response) => {
        response.json({
          success: true,
          maintenance: await runtime.maintain({
            limit: Number(request.body?.limit || 25),
          }),
        });
      })
    );
  },
});

installStandaloneShutdown(host, { name: "ResponsesRuntime" });
host
  .start()
  .then((snapshot) =>
    console.log(`[ResponsesRuntime] listening on ${host.port}`, snapshot)
  )
  .catch((error) => {
    console.error("[ResponsesRuntime] failed to start", error);
    process.exitCode = 1;
  });
