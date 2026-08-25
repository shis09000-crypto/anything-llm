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
const { ResponsesQuizRuntime } = require("./utils/responsesRuntime/quiz");
const { installQuizResponsesRuntime } = require("./utils/quiz/llm");
const {
  DEEPSEEK_RESPONSE_MODELS,
} = require("./utils/responsesRuntime/contract");
const {
  FlashCharacterAdapter,
  FLASH_CHARACTER_PROFILE,
} = require("./utils/responsesRuntime/character");
const { CharacterV2Runtime, PROFILE: CHARACTER_V2_PROFILE } =
  require("./utils/responsesRuntime/character").v2;
const { CharacterConversationRuntime } =
  require("./utils/responsesRuntime/character").conversation;
const { protect, unprotect } = require("./utils/responsesRuntime/repository");

const role = "responses-runtime";
const port = Number(process.env.RESPONSES_RUNTIME_PORT || 3034);
const runtime = new ResponsesRuntime();
installQuizResponsesRuntime(runtime);
const quizRuntime = new ResponsesQuizRuntime();
const characterRuntime = new FlashCharacterAdapter();
const characterV2Runtime = new CharacterV2Runtime();
const characterConversationRuntime = new CharacterConversationRuntime();
let modelResponsesCapabilities = null;

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
  modelResponsesCapabilities = capability;
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
  "/internal/v2/character/responses": "character.v2.responses.create",
  "/internal/v2/character/responses/stream": "character.v2.responses.stream",
  "GET /internal/v2/character/responses/:responseId":
    "character.v2.responses.retrieve",
  "/internal/v2/character/responses/:responseId/cancel":
    "character.v2.responses.cancel",
  "GET /internal/v2/character/sessions/:sessionId/.websocket":
    "character.v2.sessions",
  "/internal/v2/character/conversations": "character.v2.conversations.create",
  "GET /internal/v2/character/conversations/:conversationId":
    "character.v2.conversations.retrieve",
  "GET /internal/v2/character/conversations/:conversationId/.websocket":
    "character.v2.sessions",
  "/internal/v2/character/conversations/:conversationId/turns":
    "character.v2.conversations.turns.create",
  "/internal/v2/character/conversations/:conversationId/turns/stream":
    "character.v2.conversations.turns.stream",
  "GET /internal/v2/character/conversations/:conversationId/events":
    "character.v2.conversations.events",
  "/internal/v2/character/conversations/:conversationId/suspend":
    "character.v2.conversations.suspend",
  "/internal/v2/character/conversations/:conversationId/resume":
    "character.v2.conversations.resume",
  "/internal/v2/character/conversations/:conversationId/end":
    "character.v2.conversations.end",
  "GET /internal/v2/characters/:characterId/capabilities":
    "character.v2.capabilities.retrieve",
  "/internal/v1/character/responses": "character.responses.create",
  "GET /internal/v1/characters/:characterId/capabilities":
    "character.capabilities.retrieve",
  "/internal/v1/responses": "responses.create",
  "/internal/v1/responses/stream": "responses.stream",
  "GET /internal/v1/responses/:responseId": "responses.retrieve",
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
  "/internal/v1/responses/execution-metadata/resolve":
    "responses.execution-metadata.resolve",
  "/internal/v1/responses/quizzes/generate": "responses.quiz.execute",
  "/internal/v1/responses/quizzes/history": "responses.quiz.execute",
  "/internal/v1/responses/quizzes/:quizId/status": "responses.quiz.execute",
  "/internal/v1/responses/quizzes/:quizId/progress": "responses.quiz.execute",
  "/internal/v1/responses/quizzes/:quizId/submit": "responses.quiz.execute",
  "/internal/v1/responses/quizzes/:quizId/abandon": "responses.quiz.execute",
  "/internal/v1/responses/quizzes/:quizId/wrong-questions":
    "responses.quiz.execute",
  "/internal/v1/responses/quizzes/:quizId/wrong-questions-dismiss":
    "responses.quiz.execute",
  "/internal/v1/responses/quizzes/:quizId/favorite": "responses.quiz.execute",
};

const host = new MicroModuleServiceHost({
  manifestId: "responses-runtime",
  role,
  port,
  jsonLimit: "2mb",
  enableWebSockets: true,
  readiness: () => ({
    ...runtime.snapshot(),
    quiz: quizRuntime.snapshot(),
    characterV2: characterV2Runtime.snapshot(),
    characterConversations: characterConversationRuntime.snapshot(),
  }),
  onStart: async () => {
    await secureDatabaseStart(role);
    await dependencySelfTest();
  },
  onDrain: () => runtime.stop(),
  internalRouteCapabilities,
  registerRoutes: (app) => {
    app.post(
      "/internal/v1/responses/quizzes/generate",
      asyncRoute(async (request, response) => {
        response.json(await quizRuntime.generate(runtimeBody(request)));
      })
    );
    app.post(
      "/internal/v1/responses/quizzes/history",
      asyncRoute(async (request, response) => {
        response.json(await quizRuntime.history(runtimeBody(request)));
      })
    );
    app.post(
      "/internal/v1/responses/quizzes/:quizId/status",
      asyncRoute(async (request, response) => {
        response.json(
          await quizRuntime.status(request.params.quizId, runtimeBody(request))
        );
      })
    );
    app.post(
      "/internal/v1/responses/quizzes/:quizId/progress",
      asyncRoute(async (request, response) => {
        response.json(
          await quizRuntime.progress(
            request.params.quizId,
            runtimeBody(request)
          )
        );
      })
    );
    app.post(
      "/internal/v1/responses/quizzes/:quizId/submit",
      asyncRoute(async (request, response) => {
        response.json(
          await quizRuntime.submit(request.params.quizId, runtimeBody(request))
        );
      })
    );
    app.post(
      "/internal/v1/responses/quizzes/:quizId/abandon",
      asyncRoute(async (request, response) => {
        response.json(
          await quizRuntime.abandon(request.params.quizId, runtimeBody(request))
        );
      })
    );
    app.post(
      "/internal/v1/responses/quizzes/:quizId/wrong-questions",
      asyncRoute(async (request, response) => {
        response.json(
          await quizRuntime.wrongQuestions(
            request.params.quizId,
            runtimeBody(request)
          )
        );
      })
    );
    app.post(
      "/internal/v1/responses/quizzes/:quizId/wrong-questions-dismiss",
      asyncRoute(async (request, response) => {
        response.json(
          await quizRuntime.dismissWrongQuestions(
            request.params.quizId,
            runtimeBody(request)
          )
        );
      })
    );
    app.post(
      "/internal/v1/responses/quizzes/:quizId/favorite",
      asyncRoute(async (request, response) => {
        const body = runtimeBody(request);
        response.json(
          await quizRuntime.favorite(
            request.params.quizId,
            body,
            body.favorited !== false
          )
        );
      })
    );
    app.post(
      "/internal/v2/character/conversations",
      asyncRoute(async (request, response) => {
        response.json({
          success: true,
          conversation: await characterConversationRuntime.create(
            runtimeBody(request)
          ),
        });
      })
    );
    app.get(
      "/internal/v2/character/conversations/:conversationId",
      asyncRoute(async (request, response) => {
        response.json({
          success: true,
          conversation: await characterConversationRuntime.retrieve(
            request.params.conversationId,
            requestAthena(request)
          ),
        });
      })
    );
    app.post(
      "/internal/v2/character/conversations/:conversationId/turns",
      asyncRoute(async (request, response) => {
        response.json({
          success: true,
          ...(await characterConversationRuntime.turn(
            request.params.conversationId,
            runtimeBody(request)
          )),
        });
      })
    );
    app.post(
      "/internal/v2/character/conversations/:conversationId/turns/stream",
      asyncRoute(async (request, response) => {
        const athena = requestAthena(request);
        const before = await characterConversationRuntime.events(
          request.params.conversationId,
          -1,
          athena
        );
        const afterSequence = before.length
          ? before[before.length - 1].sequence_number
          : -1;
        await characterConversationRuntime.turn(
          request.params.conversationId,
          runtimeBody(request)
        );
        const events = await characterConversationRuntime.events(
          request.params.conversationId,
          afterSequence,
          athena
        );
        response.status(200);
        response.setHeader("Content-Type", "text/event-stream");
        response.setHeader("Cache-Control", "no-cache");
        response.setHeader("X-Accel-Buffering", "no");
        response.flushHeaders?.();
        for (const event of events) {
          if (response.destroyed) break;
          response.write(`id: ${event.sequence_number}\n`);
          response.write(`event: ${event.type}\n`);
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        if (!response.destroyed) response.end();
      })
    );
    app.get(
      "/internal/v2/character/conversations/:conversationId/events",
      asyncRoute(async (request, response) => {
        const afterSequence = Number(
          request.headers["last-event-id"] ?? request.query.after_sequence ?? -1
        );
        const events = await characterConversationRuntime.events(
          request.params.conversationId,
          afterSequence,
          requestAthena(request)
        );
        response.status(200);
        response.setHeader("Content-Type", "text/event-stream");
        response.setHeader("Cache-Control", "no-cache");
        response.setHeader("X-Accel-Buffering", "no");
        response.flushHeaders?.();
        for (const event of events) {
          response.write(`id: ${event.sequence_number}\n`);
          response.write(`event: ${event.type}\n`);
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        response.end();
      })
    );
    for (const [action, method] of [
      ["suspend", "suspend"],
      ["resume", "resume"],
      ["end", "end"],
    ])
      app.post(
        `/internal/v2/character/conversations/:conversationId/${action}`,
        asyncRoute(async (request, response) => {
          response.json({
            success: true,
            result: await characterConversationRuntime[method](
              request.params.conversationId,
              runtimeBody(request)
            ),
          });
        })
      );
    app.ws(
      "/internal/v2/character/conversations/:conversationId",
      (socket, request) => {
        socket.on("message", async (raw) => {
          try {
            const message = JSON.parse(raw.toString("utf8"));
            const body = message.request || {};
            let payload;
            if (message.type === "character.turn.create")
              payload = await characterConversationRuntime.turn(
                request.params.conversationId,
                body
              );
            else if (message.type === "character.conversation.events")
              payload = await characterConversationRuntime.events(
                request.params.conversationId,
                message.after_sequence ?? -1,
                body.athena || {}
              );
            else if (message.type === "character.conversation.suspend")
              payload = await characterConversationRuntime.suspend(
                request.params.conversationId,
                body
              );
            else if (message.type === "character.conversation.resume")
              payload = await characterConversationRuntime.resume(
                request.params.conversationId,
                body
              );
            else if (message.type === "character.conversation.end")
              payload = await characterConversationRuntime.end(
                request.params.conversationId,
                body
              );
            else throw new Error("character_conversation_message_invalid");
            const messages = Array.isArray(payload) ? payload : [payload];
            for (const entry of messages) socket.send(JSON.stringify(entry));
          } catch (error) {
            socket.send(
              JSON.stringify({
                type: "character.error",
                code: error.code || error.message,
              })
            );
          }
        });
      }
    );
    app.get(
      "/internal/v2/characters/:characterId/capabilities",
      asyncRoute(async (request, response) => {
        if (request.params.characterId !== CHARACTER_V2_PROFILE.characterId)
          return response.status(404).json({
            success: false,
            error: "character_v2_profile_not_found",
          });
        response.json({
          success: true,
          ...characterV2Runtime.capabilities(),
        });
      })
    );
    app.post(
      "/internal/v2/character/responses",
      asyncRoute(async (request, response) => {
        const record = await characterV2Runtime.complete(request.body || {});
        response.json({
          success: true,
          response: record.response,
          resolution: record.resolution,
          execution: record.execution,
        });
      })
    );
    app.post(
      "/internal/v2/character/responses/stream",
      asyncRoute(async (request, response) => {
        const afterSequence = Number(
          request.headers["last-event-id"] ?? request.body?.after_sequence ?? -1
        );
        let events;
        if (request.body?.response_id)
          events = characterV2Runtime.eventsAfter(
            request.body.response_id,
            afterSequence
          );
        else {
          const record = await characterV2Runtime.complete(request.body || {});
          events = record.events.filter(
            (event) => event.sequence_number > afterSequence
          );
        }
        response.status(200);
        response.setHeader("Content-Type", "text/event-stream");
        response.setHeader("Cache-Control", "no-cache");
        response.setHeader("X-Accel-Buffering", "no");
        response.flushHeaders?.();
        for (const event of events) {
          if (response.destroyed) break;
          response.write(`id: ${event.sequence_number}\n`);
          response.write(`event: ${event.type}\n`);
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        if (!response.destroyed) response.end();
      })
    );
    app.get(
      "/internal/v2/character/responses/:responseId",
      asyncRoute(async (request, response) => {
        response.json({
          success: true,
          ...characterV2Runtime.retrieve(request.params.responseId),
        });
      })
    );
    app.post(
      "/internal/v2/character/responses/:responseId/cancel",
      asyncRoute(async (request, response) => {
        response.json({
          success: true,
          ...characterV2Runtime.cancel(request.params.responseId),
        });
      })
    );
    app.ws("/internal/v2/character/sessions/:sessionId", (socket, request) => {
      socket.on("message", async (raw) => {
        try {
          const message = JSON.parse(raw.toString("utf8"));
          let events = [];
          if (message.type === "character.session.create") {
            const record = await characterV2Runtime.complete(
              message.request || {}
            );
            events = record.events;
          } else if (message.type === "character.session.resume") {
            events = characterV2Runtime.eventsAfter(
              message.response_id,
              message.after_sequence ?? -1
            );
          } else if (message.type === "character.session.cancel") {
            const record = characterV2Runtime.cancel(message.response_id);
            socket.send(
              JSON.stringify({
                type: "character.session.cancelled",
                session_id: request.params.sessionId,
                response: record.response,
              })
            );
            return;
          } else {
            throw Object.assign(
              new Error("character_v2_session_message_invalid"),
              { code: "character_v2_session_message_invalid" }
            );
          }
          for (const event of events) socket.send(JSON.stringify(event));
        } catch (error) {
          socket.send(
            JSON.stringify({
              type: "character.error",
              code: error.code || error.message,
            })
          );
        }
      });
    });
    app.get(
      "/internal/v1/characters/:characterId/capabilities",
      asyncRoute(async (request, response) => {
        if (request.params.characterId !== FLASH_CHARACTER_PROFILE.characterId)
          return response.status(404).json({
            success: false,
            error: "character_profile_not_found",
          });
        response.json({
          success: true,
          character_id: FLASH_CHARACTER_PROFILE.characterId,
          capability_manifest: FLASH_CHARACTER_PROFILE.manifest,
          capabilities: FLASH_CHARACTER_PROFILE.capabilities,
          generation_profiles: [
            {
              id: "flash.character-performance.v1",
              model: "deepseek-v4-flash",
              protocol_version: "1.0",
            },
          ],
        });
      })
    );
    app.post(
      "/internal/v1/character/responses",
      asyncRoute(async (request, response) => {
        response.json({
          success: true,
          response: await characterRuntime.complete(request.body || {}),
        });
      })
    );
    app.post(
      "/internal/v1/responses/execution-metadata/resolve",
      asyncRoute(async (request, response) => {
        const references = Array.isArray(request.body?.references)
          ? request.body.references.slice(0, 100)
          : [];
        response.json({
          success: true,
          items: await runtime.repository.resolveExecutionMetadata(references, {
            ownerUserId: request.body?.ownerUserId ?? null,
            workspaceId: request.body?.workspaceId ?? null,
            threadId: Object.prototype.hasOwnProperty.call(
              request.body || {},
              "threadId"
            )
              ? request.body.threadId
              : undefined,
          }),
        });
      })
    );
    app.get("/internal/v1/responses/capabilities", (_request, response) => {
      response.json({
        success: true,
        schemaVersion: "athena.responses.capabilities.v1",
        models: DEEPSEEK_RESPONSE_MODELS,
        modelRoutes: modelResponsesCapabilities?.routes || {},
        protocols: ["responses"],
        state: {
          response: true,
          conversation: true,
          characterConversation: true,
          characterTurnHandoff: true,
          characterStatePersistence: true,
          characterSoftClose: true,
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
        const responsesMaintenance = await runtime.maintain({
          limit: Number(request.body?.limit || 25),
        });
        const characterMaintenance =
          await characterConversationRuntime.maintain({
            limit: Number(request.body?.limit || 25),
          });
        response.json({
          success: true,
          maintenance: {
            ...responsesMaintenance,
            characterConversations: characterMaintenance,
          },
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
