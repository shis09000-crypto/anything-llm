const crypto = require("crypto");
const { reqBody } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { capabilitiesFor } = require("../utils/authz/accountRoles");
const {
  authenticateRealtimeRequest,
} = require("../utils/authz/realtimePrincipal");
const { requestInternalService } = require("../utils/microModules");
const { requestFastLane } = require("../utils/athena3dCenter/fastLane");
const {
  THREE_D_CENTER_TRACKS,
  centerDescriptor,
  centerEvent,
  centerTimeline,
  centerTurnFrame,
  isCenterRequest,
} = require("../utils/athena3dCenter");

function runtimeUrl(name) {
  const key =
    name === "responses"
      ? "ATHENA_RESPONSES_RUNTIME_URL"
      : name === "chat"
        ? "ATHENA_CHAT_RUNTIME_URL"
        : "ATHENA_CHARACTER_PERFORMANCE_RUNTIME_URL";
  const value = String(process.env[key] || "").replace(/\/+$/, "");
  if (!value) {
    const error = new Error(`${name}_runtime_url_missing`);
    error.code = `${name}_runtime_url_missing`;
    error.httpStatus = 503;
    throw error;
  }
  return value;
}

function ensureDeveloper(response) {
  if (
    response.locals.multiUserMode &&
    !capabilitiesFor(response.locals.user || {}).experiment
  ) {
    const error = new Error("character_performance_developer_required");
    error.code = "character_performance_developer_required";
    error.httpStatus = 403;
    throw error;
  }
}

function ownerId(response) {
  const value = Number(
    response.locals.user?.id || response.locals.authSession?.authUserId || 0
  );
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function scope(body, response) {
  const workspaceId = Number(body.workspace_id ?? body.workspaceId);
  const threadId = Number(body.thread_id ?? body.threadId);
  if (!Number.isSafeInteger(workspaceId) || workspaceId < 1) {
    const error = new Error("performance_workspace_scope_required");
    error.code = "performance_workspace_scope_required";
    error.httpStatus = 400;
    throw error;
  }
  return {
    workspace_id: workspaceId,
    thread_id: Number.isSafeInteger(threadId) && threadId > 0 ? threadId : null,
    owner_user_id: ownerId(response),
  };
}

async function call({
  target,
  capability,
  path,
  body,
  method = "POST",
  idempotencyKey,
}) {
  const base = runtimeUrl(
    target === "responses-runtime"
      ? "responses"
      : target === "chat-runtime"
        ? "chat"
        : "performance"
  );
  return requestInternalService({
    callerRole: "athena-api",
    targetModule: target,
    capability,
    contractVersion: target === "responses-runtime" ? "2.0" : "1.0",
    method,
    url: `${base}${path}`,
    body,
    idempotencyKey: idempotencyKey || crypto.randomUUID(),
    timeoutMs: 300_000,
  });
}

function characterMemoryScope(request, response) {
  const ownerUserId = ownerId(response);
  if (!ownerUserId) {
    const error = new Error("character_memory_owner_required");
    error.code = "character_memory_owner_required";
    error.httpStatus = 401;
    throw error;
  }
  return {
    ownerUserId,
    characterInstanceId: String(request.params.instanceId || "").trim(),
    ...(request.query.character_id
      ? { characterId: String(request.query.character_id) }
      : {}),
  };
}

function callCharacterMemory(operation, _path, body) {
  const url = String(
    process.env.ATHENA_3D_MEMORY_FAST_LANE_URL || "http://127.0.0.1:3116"
  ).replace(/\/+$/, "");
  return requestFastLane({
    url: `${url}/v1/dispatch`,
    operation: operation.replace(
      "3d-center.memory.long-term.",
      "memory.long_term."
    ),
    payload: body,
    timeoutMs: 30_000,
  });
}

async function retrieveSession(sessionId, requestScope) {
  const query = new URLSearchParams(
    Object.entries(requestScope)
      .filter(([, value]) => value != null)
      .map(([key, value]) => [key, String(value)])
  );
  return call({
    target: "character-performance-runtime",
    capability: "character-performance.sessions.retrieve",
    method: "GET",
    path: `/internal/v1/character-performance/sessions/${encodeURIComponent(sessionId)}?${query}`,
  });
}

async function resolveSessionScope(sessionId, response) {
  const query = new URLSearchParams(
    ownerId(response) ? { owner_user_id: String(ownerId(response)) } : {}
  );
  const result = await call({
    target: "character-performance-runtime",
    capability: "character-performance.sessions.resolve-scope",
    method: "GET",
    path: `/internal/v1/character-performance/sessions/${encodeURIComponent(sessionId)}/scope?${query}`,
  });
  return result.scope;
}

async function executeCenterResponse({
  sessionId,
  body,
  response,
  resolveAuthoritativeScope = false,
}) {
  const requestScope = resolveAuthoritativeScope
    ? await resolveSessionScope(sessionId, response)
    : scope(body, response);
  const current = await retrieveSession(sessionId, requestScope);
  if (!current.session?.conversation_id)
    throw Object.assign(new Error("performance_conversation_not_linked"), {
      code: "performance_conversation_not_linked",
      httpStatus: 409,
    });
  const turn = await call({
    target: "responses-runtime",
    capability: "character.v2.conversations.turns.create",
    path: `/internal/v2/character/conversations/${encodeURIComponent(current.session.conversation_id)}/turns`,
    body: {
      input: body.input || [
        {
          id: `chr_input_${crypto.randomUUID().replace(/-/g, "")}`,
          type: "user_message",
          content: [{ type: "input_text", text: String(body.text || "") }],
        },
      ],
      idempotency_key: body.idempotency_key || crypto.randomUUID(),
      ...(Object.prototype.hasOwnProperty.call(body, "context_ref")
        ? { context_ref: body.context_ref }
        : {}),
      athena: {
        workspaceId: requestScope.workspace_id,
        threadId: requestScope.thread_id,
        userId: requestScope.owner_user_id,
      },
    },
    idempotencyKey: body.idempotency_key,
  });
  let plan = turn.performance_plan;
  if (!plan)
    plan = (
      await call({
        target: "character-performance-runtime",
        capability: "character-performance.plans.compile",
        path: `/internal/v1/character-performance/sessions/${encodeURIComponent(sessionId)}/plans`,
        body: {
          conversation_id: current.session.conversation_id,
          response: turn.response,
          resolution: turn.performance_resolution,
          scope: requestScope,
        },
        idempotencyKey: turn.response?.id,
      })
    ).plan;
  return { turn, plan, frame: centerTurnFrame(turn, plan) };
}

function apiError(response, error) {
  response.status(Number(error.httpStatus || 500)).json({
    success: false,
    error: error.code || error.message || "character_performance_failed",
  });
}

function characterPerformanceEndpoints(app) {
  if (!app) return;

  app.get("/3d-center", [validatedRequest], (_request, response) => {
    try {
      ensureDeveloper(response);
      response.json({ success: true, center: centerDescriptor() });
    } catch (error) {
      apiError(response, error);
    }
  });

  app.post(
    ["/3d-center/sessions", "/character-performance/sessions"],
    [validatedRequest],
    async (request, response) => {
      try {
        ensureDeveloper(response);
        const body = reqBody(request) || {};
        const requestScope = scope(body, response);
        const created = await call({
          target: "character-performance-runtime",
          capability: "character-performance.sessions.create",
          path: "/internal/v1/character-performance/sessions",
          body: {
            character_id: body.character_id || "athena.test.cold_tsundere",
            character_instance_id:
              body.character_instance_id || `web_mock_${crypto.randomUUID()}`,
            client_profile: {
              adapter: body.adapter || "mock.anatomy.v1",
              runtime_version: body.runtime_version || "1.0.0",
              supported_primitives: body.supported_primitives || [
                "face.region_state",
                "gaze.target",
                "body.motion",
                "limb.motion",
                "world.action",
                "speech.text",
              ],
              installed_assets: body.installed_assets || [],
              reduced_motion: body.reduced_motion === true,
            },
            scope: requestScope,
          },
        });
        const session = created.session;
        const conversationResult = await call({
          target: "responses-runtime",
          capability: "character.v2.conversations.create",
          path: "/internal/v2/character/conversations",
          body: {
            protocol_version: "2.0",
            character: {
              character_id: body.character_id || "athena.test.cold_tsundere",
              instance_id: session.character.instance_id,
            },
            generation: {
              mode: "main_agent",
              channels: [
                "performance",
                "face",
                "gaze",
                "body",
                "action",
                "speech",
              ],
              latency_class: "interactive",
              performance_profile: "athena.cold_tsundere.expressive.v2",
            },
            previous_activity: body.previous_activity || "ambient_idle",
            metadata: { performance_session_id: session.id },
            memory:
              body.memory?.mode === "persistent" &&
              String(body.character_instance_id || "").trim()
                ? {
                    mode: "persistent",
                    recall: "profile_state_relevant",
                  }
                : { mode: "ephemeral", recall: "none" },
            athena: {
              workspaceId: requestScope.workspace_id,
              threadId: requestScope.thread_id,
              userId: requestScope.owner_user_id,
            },
          },
        });
        await call({
          target: "character-performance-runtime",
          capability: "character-performance.sessions.link",
          path: `/internal/v1/character-performance/sessions/${encodeURIComponent(session.id)}/link`,
          body: {
            conversation_id: conversationResult.conversation.id,
            scope: requestScope,
          },
        });
        const payload = {
          success: true,
          session: {
            ...session,
            conversation_id: conversationResult.conversation.id,
            context_ref: conversationResult.conversation.context_ref || null,
          },
          conversation: conversationResult.conversation,
          context_ref: conversationResult.conversation.context_ref || null,
          character_memory:
            conversationResult.conversation.character_memory || null,
          warnings: [
            ...(conversationResult.conversation.warnings || []),
            ...(!String(body.character_instance_id || "").trim() &&
            body.memory?.mode === "persistent"
              ? [
                  {
                    code: "character_memory_ephemeral",
                    message:
                      "Persistent memory requires an explicit stable character_instance_id.",
                  },
                ]
              : []),
          ],
        };
        response.status(201).json(
          isCenterRequest(request)
            ? {
                ...payload,
                object: "athena.3d_center.session",
                protocol_version: "1.0",
                center: centerDescriptor(),
              }
            : payload
        );
      } catch (error) {
        apiError(response, error);
      }
    }
  );

  app.get(
    "/3d-center/characters/:instanceId/memory",
    [validatedRequest],
    async (request, response) => {
      try {
        ensureDeveloper(response);
        const result = await callCharacterMemory(
          "3d-center.memory.long-term.status",
          "/internal/v1/3d-center/memory/long-term/status",
          characterMemoryScope(request, response)
        );
        response.json({
          success: true,
          character_memory: result.character_memory || result,
        });
      } catch (error) {
        apiError(response, error);
      }
    }
  );

  app.get(
    "/3d-center/characters/:instanceId/memory/sessions",
    [validatedRequest],
    async (request, response) => {
      try {
        ensureDeveloper(response);
        const result = await callCharacterMemory(
          "3d-center.memory.long-term.status",
          "/internal/v1/3d-center/memory/long-term/status",
          {
            ...characterMemoryScope(request, response),
            limit: Number(request.query.limit || 50),
          }
        );
        response.json({
          success: true,
          profile: result.character_memory?.profile || null,
          sessions: result.character_memory?.sessions || [],
        });
      } catch (error) {
        apiError(response, error);
      }
    }
  );

  for (const [path, kind] of [
    ["memories", "memories"],
    ["growth-nodes", "growth_nodes"],
    ["milestones", "milestones"],
  ])
    app.get(
      `/3d-center/characters/:instanceId/memory/${path}`,
      [validatedRequest],
      async (request, response) => {
        try {
          ensureDeveloper(response);
          const result = await callCharacterMemory(
            "3d-center.memory.long-term.objects.list",
            "/internal/v1/3d-center/memory/long-term/objects",
            {
              ...characterMemoryScope(request, response),
              kind,
              limit: Number(request.query.limit || 50),
            }
          );
          response.json({
            success: true,
            object: kind,
            items: result.items || result,
          });
        } catch (error) {
          apiError(response, error);
        }
      }
    );

  app.get(
    "/3d-center/characters/:instanceId/memory/sessions/:memorySessionId",
    [validatedRequest],
    async (request, response) => {
      try {
        ensureDeveloper(response);
        const result = await callCharacterMemory(
          "3d-center.memory.long-term.status",
          "/internal/v1/3d-center/memory/long-term/status",
          {
            ...characterMemoryScope(request, response),
            memorySessionId: request.params.memorySessionId,
          }
        );
        response.json({
          success: true,
          character_memory: result.character_memory,
        });
      } catch (error) {
        apiError(response, error);
      }
    }
  );

  app.delete(
    "/3d-center/characters/:instanceId/memory/sessions/:memorySessionId",
    [validatedRequest],
    async (request, response) => {
      try {
        ensureDeveloper(response);
        const result = await callCharacterMemory(
          "3d-center.memory.long-term.session.delete",
          "/internal/v1/3d-center/memory/long-term/session/delete",
          {
            ...characterMemoryScope(request, response),
            memorySessionId: request.params.memorySessionId,
          }
        );
        response.json({ success: true, deletion: result.deletion });
      } catch (error) {
        apiError(response, error);
      }
    }
  );

  app.delete(
    "/3d-center/characters/:instanceId/memory",
    [validatedRequest],
    async (request, response) => {
      try {
        ensureDeveloper(response);
        const result = await callCharacterMemory(
          "3d-center.memory.long-term.profile.reset",
          "/internal/v1/3d-center/memory/long-term/profile/reset",
          characterMemoryScope(request, response)
        );
        response.json({ success: true, deletion: result.deletion });
      } catch (error) {
        apiError(response, error);
      }
    }
  );

  app.post(
    "/3d-center/characters/:instanceId/memory/reconsolidate",
    [validatedRequest],
    async (request, response) => {
      try {
        ensureDeveloper(response);
        const body = reqBody(request) || {};
        const result = await callCharacterMemory(
          "3d-center.memory.long-term.reconsolidate",
          "/internal/v1/3d-center/memory/long-term/reconsolidate",
          {
            ...characterMemoryScope(request, response),
            memorySessionId: body.memory_session_id || null,
          }
        );
        response.status(202).json({
          success: true,
          reconsolidation: result.reconsolidation || result,
        });
      } catch (error) {
        apiError(response, error);
      }
    }
  );

  app.get(
    [
      "/3d-center/sessions/:sessionId",
      "/character-performance/sessions/:sessionId",
    ],
    [validatedRequest],
    async (request, response) => {
      try {
        ensureDeveloper(response);
        const requestScope = scope(request.query, response);
        const result = await retrieveSession(
          request.params.sessionId,
          requestScope
        );
        let conversation = null;
        if (result.session?.conversation_id) {
          const conversationQuery = new URLSearchParams(
            Object.entries({
              workspaceId: requestScope.workspace_id,
              threadId: requestScope.thread_id,
              userId: requestScope.owner_user_id,
            })
              .filter(([, value]) => value != null)
              .map(([key, value]) => [key, String(value)])
          );
          conversation = await call({
            target: "responses-runtime",
            capability: "character.v2.conversations.retrieve",
            method: "GET",
            path: `/internal/v2/character/conversations/${encodeURIComponent(result.session.conversation_id)}?${conversationQuery}`,
          });
        }
        response.json(
          isCenterRequest(request)
            ? {
                success: true,
                object: "athena.3d_center.session",
                protocol_version: "1.0",
                center: centerDescriptor(),
                session: {
                  ...result.session,
                  context_ref: conversation?.conversation?.context_ref || null,
                },
                context_ref: conversation?.conversation?.context_ref || null,
              }
            : result
        );
      } catch (error) {
        apiError(response, error);
      }
    }
  );

  app.post(
    "/3d-center/sessions/:sessionId/responses",
    [validatedRequest],
    async (request, response) => {
      try {
        ensureDeveloper(response);
        const body = reqBody(request) || {};
        if (body.protocol_version !== "1.0")
          throw Object.assign(new Error("athena_3d_context_protocol_invalid"), {
            code: "athena_3d_context_protocol_invalid",
            httpStatus: 400,
          });
        if (!Object.prototype.hasOwnProperty.call(body, "context_ref"))
          throw Object.assign(new Error("athena_3d_context_ref_required"), {
            code: "athena_3d_context_ref_required",
            httpStatus: 400,
          });
        if (!String(body.idempotency_key || "").trim())
          throw Object.assign(
            new Error("athena_3d_context_idempotency_key_required"),
            {
              code: "athena_3d_context_idempotency_key_required",
              httpStatus: 400,
            }
          );
        const { turn, frame } = await executeCenterResponse({
          sessionId: request.params.sessionId,
          body,
          response,
          resolveAuthoritativeScope: true,
        });
        response.json({
          success: true,
          object: "athena.3d_center.response",
          protocol_version: "1.0",
          response: {
            id: turn.response?.id || null,
            status: turn.response?.status || "completed",
            previous_response_id:
              turn.response?.conversation?.previous_response_id || null,
          },
          context: turn.context,
          frame,
          warnings: turn.warnings || [],
        });
      } catch (error) {
        apiError(response, error);
      }
    }
  );

  app.post(
    [
      "/3d-center/sessions/:sessionId/turns",
      "/character-performance/sessions/:sessionId/turns",
    ],
    [validatedRequest],
    async (request, response) => {
      try {
        ensureDeveloper(response);
        const body = reqBody(request) || {};
        const { turn, plan, frame } = await executeCenterResponse({
          sessionId: request.params.sessionId,
          body,
          response,
        });
        response.json(
          isCenterRequest(request)
            ? {
                success: true,
                object: "athena.3d_center.turn",
                protocol_version: "1.0",
                frame,
              }
            : { success: true, ...turn, performance_plan: plan }
        );
      } catch (error) {
        apiError(response, error);
      }
    }
  );

  app.post(
    [
      "/3d-center/sessions/:sessionId/replay",
      "/character-performance/sessions/:sessionId/replay",
    ],
    [validatedRequest],
    async (request, response) => {
      try {
        ensureDeveloper(response);
        const current = await retrieveSession(
          request.params.sessionId,
          scope(reqBody(request) || {}, response)
        );
        if (!current.session?.latest_plan)
          return response
            .status(404)
            .json({ success: false, error: "performance_plan_not_found" });
        response.json(
          isCenterRequest(request)
            ? {
                success: true,
                object: "athena.3d_center.replay",
                protocol_version: "1.0",
                replay: true,
                timeline: centerTimeline(current.session.latest_plan),
                performance_plan: current.session.latest_plan,
              }
            : {
                success: true,
                plan: current.session.latest_plan,
                replay: true,
              }
        );
      } catch (error) {
        apiError(response, error);
      }
    }
  );

  if (typeof app.ws === "function") {
    const createStreamHandler =
      ({ centerWire = false } = {}) =>
      async (socket, request) => {
        try {
          const principal = await authenticateRealtimeRequest({
            request,
            purpose: centerWire ? "athena-3d-center" : "character-performance",
            resourceId: request.params.sessionId,
            authoritative: true,
          });
          if (
            principal.multiUser &&
            !capabilitiesFor(principal.user || {}).experiment
          )
            throw Object.assign(
              new Error("character_performance_developer_required"),
              {
                code: "character_performance_developer_required",
              }
            );
          let after = Number(request.query.after_sequence ?? -1);
          const requestScope = {
            workspace_id: Number(request.query.workspace_id),
            thread_id: Number(request.query.thread_id) || null,
            owner_user_id: principal.user?.id || null,
          };
          let polling = false;
          const poll = async () => {
            if (polling || socket.readyState !== 1) return;
            polling = true;
            try {
              const query = new URLSearchParams({
                after_sequence: String(after),
                workspace_id: String(requestScope.workspace_id),
                ...(requestScope.thread_id
                  ? { thread_id: String(requestScope.thread_id) }
                  : {}),
                ...(requestScope.owner_user_id
                  ? { owner_user_id: String(requestScope.owner_user_id) }
                  : {}),
              });
              const result = await call({
                target: "character-performance-runtime",
                capability: "character-performance.events.retrieve",
                method: "GET",
                path: `/internal/v1/character-performance/sessions/${encodeURIComponent(request.params.sessionId)}/events?${query}`,
              });
              for (const event of result.events || []) {
                after = Math.max(after, event.sequence_number);
                socket.send(
                  JSON.stringify(centerWire ? centerEvent(event) : event)
                );
              }
            } finally {
              polling = false;
            }
          };
          const timer = setInterval(() => void poll(), 250);
          timer.unref?.();
          socket.on("close", () => clearInterval(timer));
          socket.on("message", async (raw) => {
            const message = JSON.parse(raw.toString("utf8"));
            const feedback = centerWire ? message.feedback : message;
            const expectedType = centerWire
              ? "athena.3d_center.execution_feedback"
              : "character.execution.feedback";
            if (message.type !== expectedType || !feedback) return;
            await call({
              target: "character-performance-runtime",
              capability: "character-performance.feedback.create",
              path: `/internal/v1/character-performance/sessions/${encodeURIComponent(request.params.sessionId)}/execution-feedback`,
              body: { ...feedback, scope: requestScope },
              idempotencyKey: feedback.events?.[0]?.event_id,
            });
            await poll();
          });
          await poll();
        } catch (error) {
          socket.close(1008, String(error.code || error.message).slice(0, 120));
        }
      };
    app.ws(
      "/3d-center/sessions/:sessionId/stream",
      createStreamHandler({ centerWire: true })
    );
    app.ws(
      "/character-performance/sessions/:sessionId/stream",
      createStreamHandler()
    );
  }
}

module.exports = {
  THREE_D_CENTER_TRACKS,
  centerDescriptor,
  centerTimeline,
  centerTurnFrame,
  characterPerformanceEndpoints,
};
