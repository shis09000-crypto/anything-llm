const {
  TelemetryRepository: Telemetry,
} = require("../repositories/telemetryRepository");
const { DataAccessCenter } = require("../utils/dataAccess");
const { AgentHandler } = require("../utils/agents");
const {
  WEBSOCKET_BAIL_COMMANDS,
} = require("../utils/agents/aibitat/plugins/websocket");
const { safeJsonParse } = require("../utils/http");
const { clearInvocationFileAccess } = require("../utils/chats/agents");
const {
  cacheInvocationAttachments,
  cacheInvocationExecutionTarget,
  cacheInvocationFileAccess,
} = require("../utils/chats/agents");
const {
  drainAgentSessionJournal,
  getAgentSessionState,
  ensureDurableAgentSession,
  loadDurableAgentSession,
  markAgentSessionState,
  recordAgentSessionEvent,
  startAgentRunHeartbeat,
  stopAgentRunHeartbeat,
} = require("../utils/agents/agentSessionLedger");
const {
  getAuthorizedAgentInvocation,
} = require("../utils/authz/resourceAccess");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  ensureSecureWebSocketRequest,
} = require("../utils/security/transportSecurity");
const {
  attachAuthenticatedClientContext,
  recordClientTrustCheckpoint,
} = require("../utils/clientIdentity");
const {
  signingErrorCode,
  signingWarnOnly,
  verifySignedWebSocketMessage,
} = require("../utils/requestSigning");
const {
  authenticateRealtimeRequest,
  monitorRealtimePrincipal,
} = require("../utils/authz/realtimePrincipal");
const { emitSemanticEvent } = require("../utils/observability/semanticEvents");
const {
  agentPersistenceContractSnapshot,
} = require("../utils/agents/invocationPersistenceContract");

const WorkspaceAgentInvocation = DataAccessCenter.workspaceAgentInvocation;
const activeAgentSessions = new Map();

function agentRuntimeSnapshot() {
  const persistenceContract = agentPersistenceContractSnapshot();
  return {
    ready: persistenceContract.ready,
    reasonCode: persistenceContract.reasonCode,
    activeSessions: activeAgentSessions.size,
    persistenceContract,
  };
}

async function drainAgentRuntime({ timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + Math.max(1_000, Number(timeoutMs) || 0);
  while (activeAgentSessions.size > 0 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  const journal = await drainAgentSessionJournal();
  return {
    drained: activeAgentSessions.size === 0 && journal.pendingWrites === 0,
    ...agentRuntimeSnapshot(),
    journal,
  };
}

function emitAgentTransportEvent(uuid, eventType, outcome, invocation = null) {
  emitSemanticEvent({
    eventType,
    category: "agent",
    severity: outcome === "failed" ? "warning" : "info",
    outcome,
    subject: {
      type: "agent-invocation",
      id: String(uuid),
      component: "agent-websocket",
    },
    actor: {
      type: invocation?.user_id ? "user" : "system",
      id: invocation?.user_id || "system",
    },
    correlation: {
      invocationId: String(uuid),
      clientTurnId: invocation?.clientTurnId || undefined,
    },
    impact: {
      scope: "conversation-run",
      status: outcome,
    },
    sensitivity: "metadata_only",
  });
}

function agentSilencePolicy(provider = null, model = null) {
  const normalizedProvider = String(provider || "").toLowerCase();
  const normalizedModel = String(model || "").toLowerCase();
  const configured = [
    {
      tier: "rough",
      provider: process.env.LLM_TASK_ROUGH_PROVIDER,
      model: process.env.LLM_TASK_ROUGH_MODEL,
      silenceTimeoutMs: 50_000,
    },
    {
      tier: "refined",
      provider: process.env.LLM_TASK_REFINED_PROVIDER,
      model: process.env.LLM_TASK_REFINED_MODEL,
      silenceTimeoutMs: 90_000,
    },
    {
      tier: "ultra",
      provider: process.env.LLM_TASK_ULTRA_PROVIDER,
      model: process.env.LLM_TASK_ULTRA_MODEL,
      silenceTimeoutMs: 120_000,
    },
  ].find(
    (tier) =>
      tier.provider &&
      tier.model &&
      String(tier.provider).toLowerCase() === normalizedProvider &&
      String(tier.model).toLowerCase() === normalizedModel
  );
  if (configured) return configured;
  if (normalizedModel.includes("flash") || normalizedModel.includes("rough"))
    return { tier: "rough", silenceTimeoutMs: 50_000 };
  if (normalizedModel.includes("ultra") || normalizedModel.includes("max"))
    return { tier: "ultra", silenceTimeoutMs: 120_000 };
  return { tier: "refined", silenceTimeoutMs: 90_000 };
}

class ResumableAgentSocket {
  constructor(uuid) {
    this.uuid = String(uuid);
    this.currentSocket = null;
    this.listeners = { message: [], close: [] };
    this.__agentFinalClose = false;
    this.__clientStopped = false;
    this.handleFeedback = null;
    this.handleToolApproval = null;
    this.activeToolApprovalRequest = null;
    this.handleClarificationResponse = null;
    this.activeClarificationRequest = null;
  }

  attach(socket) {
    this.currentSocket = socket;
    const current = getAgentSessionState(this.uuid);
    if (!current.terminal) {
      markAgentSessionState(this.uuid, {
        status: "running",
        closed: false,
        retryable: true,
        connectedAt: Date.now(),
      });
    }
  }

  detach(socket) {
    if (this.currentSocket === socket) this.currentSocket = null;
  }

  on(eventName, handler) {
    if (!this.listeners[eventName]) this.listeners[eventName] = [];
    this.listeners[eventName].push(handler);
  }

  emit(eventName, ...args) {
    for (const handler of this.listeners[eventName] || []) {
      try {
        handler(...args);
      } catch (error) {
        console.error(`[agent-session] ${eventName} handler failed`, error);
      }
    }
  }

  send(rawPayload) {
    const payload =
      typeof rawPayload === "string" ? safeJsonParse(rawPayload, null) : null;
    const record = payload ? recordAgentSessionEvent(this.uuid, payload) : null;
    const nextPayload = record?.deliveryPayload || record?.payload || payload;
    if (!this.currentSocket || this.currentSocket.readyState !== 1) return;

    try {
      this.currentSocket.send(JSON.stringify(nextPayload ?? rawPayload));
    } catch (error) {
      console.warn(
        `[agent-session] Failed to send socket event for ${this.uuid}: ${error.message}`
      );
    }
  }

  close() {
    if (this.currentSocket && this.currentSocket.readyState === 1) {
      this.currentSocket.close();
      return;
    }
    this.emit("close");
  }

  receiveClarificationResponse(payload = {}) {
    if (!payload?.requestId) {
      return { ok: false, reason: "missing_request_id" };
    }
    if (!this.handleClarificationResponse || !this.activeClarificationRequest) {
      return { ok: false, reason: "clarification_not_waiting" };
    }
    if (this.activeClarificationRequest.requestId !== payload.requestId) {
      return { ok: false, reason: "request_id_mismatch" };
    }

    const result = this.handleClarificationResponse(JSON.stringify(payload));
    if (result?.ok) {
      this.send(
        JSON.stringify({
          type: "clarificationResolved",
          requestId: payload.requestId,
          skipped: !!payload.skipped,
        })
      );
      return result;
    }
    return {
      ok: false,
      reason: result?.reason || "clarification_not_waiting",
      error: result?.error,
    };
  }

  receiveToolApprovalResponse(payload = {}) {
    if (!payload?.requestId) {
      return { ok: false, reason: "missing_request_id" };
    }
    if (!this.handleToolApproval || !this.activeToolApprovalRequest) {
      return { ok: false, reason: "approval_not_waiting" };
    }
    if (this.activeToolApprovalRequest.requestId !== payload.requestId) {
      return { ok: false, reason: "request_id_mismatch" };
    }
    this.handleToolApproval(JSON.stringify(payload));
    return { ok: true };
  }
}

class InternalAgentStreamSink {
  constructor({ onEvent, onClose }) {
    this.readyState = 1;
    this.onEvent = onEvent;
    this.onClose = onClose;
  }

  send(rawPayload) {
    if (this.readyState !== 1) return;
    const payload =
      typeof rawPayload === "string"
        ? safeJsonParse(rawPayload, null)
        : rawPayload;
    if (payload) this.onEvent(payload);
  }

  close() {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.onClose?.();
  }
}

/**
 * Run one durable Agent invocation without exposing the Agent websocket to the
 * browser. The caller receives the same durable event stream over the internal
 * service link and owns the outer Responses turn lifecycle.
 */
async function streamAgentInvocation({
  uuid,
  onEvent,
  attachments = [],
  displayAttachments = attachments,
  displayPrompt = null,
  reservedPublicChatId = null,
  visionAnalysisContext = null,
  fileAccess = {},
  executionTarget = null,
} = {}) {
  uuid = String(uuid || "").trim();
  if (!uuid) {
    const error = new Error("agent_invocation_id_required");
    error.code = "agent_invocation_id_required";
    throw error;
  }
  if (activeAgentSessions.has(uuid)) {
    const error = new Error("agent_invocation_already_running");
    error.code = "agent_invocation_already_running";
    error.httpStatus = 409;
    throw error;
  }

  cacheInvocationAttachments(uuid, {
    llmAttachments: attachments,
    displayAttachments,
    displayPrompt,
    reservedPublicChatId,
    visionAnalysisContext,
  });
  cacheInvocationFileAccess(uuid, fileAccess);
  cacheInvocationExecutionTarget(uuid, executionTarget);

  const ownership = await ensureDurableAgentSession(uuid);
  if (ownership && ownership.claimed === false) {
    const error = new Error("agent_invocation_already_owned");
    error.code = "agent_invocation_already_owned";
    error.httpStatus = 409;
    throw error;
  }

  startAgentRunHeartbeat(uuid);
  const agentHandler = await new AgentHandler({ uuid }).init();
  if (!agentHandler.invocation) {
    const error = new Error("agent_invocation_not_found");
    error.code = "agent_invocation_not_found";
    error.httpStatus = 404;
    throw error;
  }

  const silencePolicy = agentSilencePolicy(
    agentHandler.provider,
    agentHandler.model
  );
  markAgentSessionState(uuid, {
    provider: agentHandler.provider,
    model: agentHandler.model,
    modelTier: silencePolicy.tier,
    silenceTimeoutMs: silencePolicy.silenceTimeoutMs,
    status: "running",
    closed: false,
    retryable: true,
  });

  const bridge = new ResumableAgentSocket(uuid);
  const session = { uuid, agentHandler, bridge, started: true };
  activeAgentSessions.set(uuid, session);

  let terminalSeen = false;
  let closeResolve;
  const closed = new Promise((resolve) => {
    closeResolve = resolve;
  });
  const finalize = () => {
    bridge.detach(sink);
    const current = getAgentSessionState(uuid);
    markAgentSessionState(uuid, {
      status: terminalSeen ? "completed" : current.status || "closed",
      closed: true,
      retryable: false,
      terminal: true,
      closedAt: Date.now(),
    });
    WorkspaceAgentInvocation.close(uuid);
    clearInvocationFileAccess(uuid);
    activeAgentSessions.delete(uuid);
    stopAgentRunHeartbeat(uuid);
    closeResolve();
  };
  const sink = new InternalAgentStreamSink({
    onEvent: (event) => {
      onEvent?.(event);
      if (event?.type !== "response.completed") return;
      terminalSeen = true;
      bridge.__agentFinalClose = true;
      queueMicrotask(() => bridge.close());
    },
    onClose: finalize,
  });
  bridge.attach(sink);

  try {
    await Telemetry.sendTelemetry("agent_chat_started");
    await agentHandler.createAIbitat({ socket: bridge });
    await agentHandler.startAgentCluster();
    if (terminalSeen && sink.readyState === 1) bridge.close();
    await closed;
  } catch (error) {
    console.error("[AgentTurn] execution failed", {
      invocationId: uuid,
      errorCode: error?.code || "agent_turn_failed",
      message: error?.message || "Agent turn failed.",
    });
    if (sink.readyState === 1) {
      onEvent?.({
        type: "response.failed",
        response: {
          id: uuid,
          object: "response",
          status: "failed",
          error: {
            code: error?.code || "agent_turn_failed",
            message: error?.message || "Agent turn failed.",
          },
        },
      });
      bridge.__agentFinalClose = true;
      sink.close();
    }
    throw error;
  }
}

function submitAgentInvocationAction(uuid, actionId, body = {}) {
  const session = activeAgentSessions.get(String(uuid));
  if (!session?.bridge)
    return { success: false, error: "agent_session_not_active" };
  const action = String(body.action || body.type || "").toLowerCase();
  if (action === "approval" || Object.hasOwn(body, "approved")) {
    const result = session.bridge.receiveToolApprovalResponse({
      type: "toolApprovalResponse",
      requestId: actionId,
      approved: !!body.approved,
    });
    return result?.ok
      ? { success: true, actionId }
      : { success: false, error: result?.reason || "approval_not_waiting" };
  }
  if (
    action === "clarification" ||
    Array.isArray(body.answers) ||
    body.skipped === true
  ) {
    const result = session.bridge.receiveClarificationResponse({
      type: "clarificationResponse",
      requestId: actionId,
      answers: Array.isArray(body.answers) ? body.answers : [],
      skipped: !!body.skipped,
    });
    return result?.ok
      ? { success: true, actionId }
      : {
          success: false,
          error: result?.reason || "clarification_not_waiting",
        };
  }
  return { success: false, error: "response_action_type_invalid" };
}

async function cancelAgentInvocation(uuid) {
  uuid = String(uuid || "").trim();
  const session = activeAgentSessions.get(uuid);
  await WorkspaceAgentInvocation.close(uuid);
  if (!session?.bridge) return { success: true, closed: true };
  session.bridge.__clientStopped = true;
  session.agentHandler?.aibitat?.abort?.();
  session.bridge.close();
  return { success: true, closed: true };
}

// Setup listener for incoming messages to relay to socket so it can be handled by agent plugin.
function relayToSocket(message) {
  if (this.handleFeedback) return this?.handleFeedback?.(message);
  if (this.handleToolApproval) return this?.handleToolApproval?.(message);
  if (this.handleClarificationResponse)
    return this?.handleClarificationResponse?.(message);
  this.checkBailCommand(message);
}

function agentControlAction(message) {
  const payload =
    message && typeof message === "object"
      ? message
      : safeJsonParse(message, null);
  if (!payload?.type) return null;
  if (payload.type === "toolApprovalResponse") return "agent_approval";
  if (payload.type === "clarificationResponse") return "agent_clarification";
  if (payload.type === "awaitingFeedback") {
    return WEBSOCKET_BAIL_COMMANDS.includes(payload.feedback)
      ? "agent_stop"
      : "agent_feedback";
  }
  return null;
}

function clarificationResponsePayload(body = {}) {
  return {
    type: "clarificationResponse",
    requestId: body.requestId,
    skipped: !!body.skipped,
    answers: Array.isArray(body.answers) ? body.answers : [],
  };
}

function toolApprovalResponsePayload(body = {}) {
  return {
    type: "toolApprovalResponse",
    requestId: body.requestId,
    approved: !!body.approved,
  };
}

function logClarificationResponse({
  uuid,
  payload,
  signed = false,
  reasonCode = null,
  transport,
}) {
  if (process.env.NODE_ENV !== "development") return;
  console.log("[agent-session] clarificationResponse received", {
    uuid,
    requestId: payload?.requestId || null,
    answerCount: Array.isArray(payload?.answers) ? payload.answers.length : 0,
    signed,
    reasonCode,
    transport,
  });
}

function agentWebsocket(app) {
  if (!app) return;

  app.get(
    "/agent-invocation/:uuid/state",
    [validatedRequest],
    async function (request, response) {
      const uuid = String(request.params.uuid);
      const authorized = await getAuthorizedAgentInvocation({
        request,
        response,
        uuid,
      });
      if (!authorized) {
        return response.status(404).json({
          success: false,
          error: "agent_invocation_not_found",
        });
      }
      const { invocation } = authorized;
      const includeEvents = request.query?.includeEvents === "1";
      const requestedAfterSeq = Number(request.query?.afterSeq || 0);
      const afterSeq = Number.isFinite(requestedAfterSeq)
        ? Math.max(0, requestedAfterSeq)
        : 0;

      const durable = await loadDurableAgentSession(uuid, afterSeq);
      return response.status(200).json({
        success: true,
        state: {
          ...durable.state,
          closed: !!invocation.closed,
          retryable: !invocation.closed && durable.state.terminal !== true,
          clientTurnId:
            durable.state.clientTurnId || invocation.clientTurnId || null,
        },
        ...(includeEvents
          ? {
              events: durable.events
                .slice(0, 100)
                .map((event) => event.payload),
            }
          : {}),
      });
    }
  );

  app.post(
    "/agent-invocation/:uuid/tool-approval-response",
    [validatedRequest],
    async function (request, response) {
      const uuid = String(request.params.uuid);
      const authorized = await getAuthorizedAgentInvocation({
        request,
        response,
        uuid,
      });
      if (!authorized) {
        return response.status(404).json({
          success: false,
          error: "agent_invocation_not_found",
        });
      }

      await attachAuthenticatedClientContext({
        request,
        user: authorized.user,
      });
      const session = activeAgentSessions.get(uuid);
      if (!session?.bridge) {
        return response.status(409).json({
          success: false,
          error: "agent_session_not_active",
        });
      }

      const payload = toolApprovalResponsePayload(request.body || {});
      const result = session.bridge.receiveToolApprovalResponse(payload);
      if (!result?.ok) {
        return response.status(409).json({
          success: false,
          error: result?.reason || "approval_not_waiting",
        });
      }
      void recordClientTrustCheckpoint(request, {
        action: "agent_approval",
        resourceType: "agent_invocation",
        resourceId: uuid,
        outcome: "received",
        metadata: { transport: "http_fallback" },
      });
      return response.status(200).json({
        success: true,
        requestId: payload.requestId,
      });
    }
  );

  app.post(
    "/agent-invocation/:uuid/clarification-response",
    [validatedRequest],
    async function (request, response) {
      const uuid = String(request.params.uuid);
      const authorized = await getAuthorizedAgentInvocation({
        request,
        response,
        uuid,
      });
      if (!authorized) {
        return response.status(404).json({
          success: false,
          error: "agent_invocation_not_found",
        });
      }

      await attachAuthenticatedClientContext({
        request,
        user: authorized.user,
      });

      const session = activeAgentSessions.get(uuid);
      if (!session?.bridge) {
        return response.status(409).json({
          success: false,
          error: "agent_session_not_active",
        });
      }

      const payload = clarificationResponsePayload(request.body || {});
      const result = session.bridge.receiveClarificationResponse(payload);
      if (!result?.ok) {
        return response.status(409).json({
          success: false,
          error: result?.reason || "clarification_not_waiting",
        });
      }

      void recordClientTrustCheckpoint(request, {
        action: "agent_clarification",
        resourceType: "agent_invocation",
        resourceId: uuid,
        outcome: "received",
        metadata: { transport: "http_fallback" },
      });
      logClarificationResponse({
        uuid,
        payload,
        transport: "http_fallback",
      });
      return response.status(200).json({
        success: true,
        requestId: payload.requestId,
      });
    }
  );

  app.post(
    "/agent-invocation/:uuid/stop",
    [validatedRequest],
    async function (request, response) {
      const uuid = String(request.params.uuid);
      const authorized = await getAuthorizedAgentInvocation({
        request,
        response,
        uuid,
      });
      if (!authorized) {
        return response.status(404).json({
          success: false,
          error: "agent_invocation_not_found",
        });
      }

      await attachAuthenticatedClientContext({
        request,
        user: authorized.user,
      });

      const invocationClosed = await WorkspaceAgentInvocation.close(uuid);
      if (!invocationClosed) {
        return response.status(500).json({
          success: false,
          error: "agent_stop_persist_failed",
        });
      }

      const session = activeAgentSessions.get(uuid);
      if (session?.bridge) {
        session.bridge.__clientStopped = true;
        session.agentHandler?.log?.(
          "User invoked the authenticated HTTP stop fallback. Closing session now."
        );
        session.agentHandler?.aibitat?.abort?.();
        session.bridge.close();
      }

      clearInvocationFileAccess(uuid);
      markAgentSessionState(uuid, {
        status: "stopped",
        closed: true,
        retryable: false,
        closedAt: Date.now(),
      });
      activeAgentSessions.delete(uuid);

      void recordClientTrustCheckpoint(request, {
        action: "agent_stop",
        resourceType: "agent_invocation",
        resourceId: uuid,
        outcome: "confirmed",
        metadata: { transport: "http_fallback" },
      });
      return response.status(200).json({
        success: true,
        closed: true,
      });
    }
  );

  app.ws("/agent-invocation/:uuid", async function (socket, request) {
    if (!ensureSecureWebSocketRequest(request, socket)) return;

    const uuid = String(request.params.uuid);
    try {
      const principal = await authenticateRealtimeRequest({
        request,
        purpose: "agent",
        resourceId: uuid,
        authoritative: true,
      });
      const stopPrincipalMonitor = monitorRealtimePrincipal({
        request,
        socket,
      });
      const authorized = await getAuthorizedAgentInvocation({
        request,
        uuid,
      });
      if (!authorized) {
        stopPrincipalMonitor();
        socket.close(1008);
        return;
      }
      await attachAuthenticatedClientContext({
        request,
        user: principal.user || authorized.user,
      });
      const invocation = authorized.invocation;
      const requestedLastSeq = Number(request.query?.lastEventSeq || 0);
      const lastEventSeq = Number.isFinite(requestedLastSeq)
        ? requestedLastSeq
        : 0;
      const isResume = request.query?.resume === "1";
      let session = activeAgentSessions.get(uuid);

      if (isResume && !session) {
        if (invocation.closed) {
          const durable = await loadDurableAgentSession(uuid, lastEventSeq);
          const terminalState = durable.state;
          socket.send(
            JSON.stringify({
              type: "agentReplayStart",
              latestSeq: terminalState.latestSeq || 0,
            })
          );
          for (const event of durable.events) {
            if (socket.readyState !== 1) break;
            socket.send(JSON.stringify(event.payload));
          }
          socket.send(
            JSON.stringify({
              type: "agentReplayEnd",
              latestSeq: terminalState.latestSeq || 0,
              terminal: true,
              status: terminalState.status || "closed",
              finalChatId: terminalState.finalChatId || null,
              finalPublicChatId: terminalState.finalPublicChatId || null,
              clientTurnId:
                terminalState.clientTurnId || invocation.clientTurnId || null,
            })
          );
          emitAgentTransportEvent(
            uuid,
            "agent.invocation.replayed",
            "recovered",
            invocation
          );
          socket.close();
          return;
        }
      }

      if (!session) {
        const ownership = await ensureDurableAgentSession(uuid);
        if (ownership && ownership.claimed === false) {
          socket.send(
            JSON.stringify({
              type: "agentResumePending",
              status: ownership.run?.status || "running",
              retryAfterMs: 1_000,
            })
          );
          socket.close(1013);
          return;
        }
        startAgentRunHeartbeat(uuid);
        const agentHandler = await new AgentHandler({ uuid }).init();
        if (!agentHandler.invocation) {
          socket.close();
          return;
        }
        const silencePolicy = agentSilencePolicy(
          agentHandler.provider,
          agentHandler.model
        );
        markAgentSessionState(uuid, {
          provider: agentHandler.provider,
          model: agentHandler.model,
          modelTier: silencePolicy.tier,
          silenceTimeoutMs: silencePolicy.silenceTimeoutMs,
        });

        session = {
          uuid,
          agentHandler,
          bridge: new ResumableAgentSocket(uuid),
          started: false,
        };
        session.bridge.on("close", () => {
          if (
            !session.bridge.__agentFinalClose &&
            !session.bridge.__clientStopped
          )
            return;
          agentHandler.closeAlert();
          WorkspaceAgentInvocation.close(uuid);
          clearInvocationFileAccess(uuid);
          const current = getAgentSessionState(uuid);
          const completed = current.terminal && current.status === "completed";
          markAgentSessionState(uuid, {
            status: session.bridge.__clientStopped
              ? "stopped"
              : completed
                ? "completed"
                : "closed",
            closed: true,
            retryable: false,
            terminal: true,
            closedAt: Date.now(),
          });
          activeAgentSessions.delete(uuid);
          stopAgentRunHeartbeat(uuid);
        });
        activeAgentSessions.set(uuid, session);
      }

      const { agentHandler, bridge } = session;
      bridge.attach(socket);

      socket.on("message", async (message) => {
        const verification = await verifySignedWebSocketMessage(
          request,
          message
        );
        const action = agentControlAction(verification.payload || message);
        const isSignedEnvelope = !verification.unsigned;
        if (!verification.ok && (action || isSignedEnvelope)) {
          void recordClientTrustCheckpoint(request, {
            action: action || "agent_signed_message",
            resourceType: "agent_invocation",
            resourceId: uuid,
            outcome: signingWarnOnly() ? "warn_only" : "rejected",
            metadata: {
              signatureResult: "failed",
              reasonCode: verification.reasonCode || "failed",
            },
          });
          if (!signingWarnOnly()) {
            try {
              socket.send(
                JSON.stringify({
                  type: "wssFailure",
                  content: "Signed request verification failed.",
                  code: signingErrorCode(verification.reasonCode),
                })
              );
            } catch {}
            socket.close(1008);
            return;
          }
        }

        if (action) {
          void recordClientTrustCheckpoint(request, {
            action,
            resourceType: "agent_invocation",
            resourceId: uuid,
            outcome: "received",
          });
          if (
            process.env.NODE_ENV === "development" &&
            action === "agent_clarification"
          ) {
            const payload = verification.payload || safeJsonParse(message, {});
            logClarificationResponse({
              uuid,
              payload,
              signed: verification.ok,
              reasonCode: verification.reasonCode || null,
              transport: "websocket",
            });
          }
        }
        relayToSocket.call(bridge, verification.rawMessage || message);
      });
      socket.on("close", () => {
        bridge.detach(socket);
        if (bridge.__agentFinalClose || bridge.__clientStopped) {
          agentHandler.closeAlert();
          WorkspaceAgentInvocation.close(uuid);
          clearInvocationFileAccess(uuid);
          const current = getAgentSessionState(uuid);
          const completed = current.terminal && current.status === "completed";
          markAgentSessionState(uuid, {
            status: bridge.__clientStopped
              ? "stopped"
              : completed
                ? "completed"
                : "closed",
            closed: true,
            retryable: false,
            terminal: true,
            closedAt: Date.now(),
          });
          activeAgentSessions.delete(uuid);
          stopAgentRunHeartbeat(uuid);
          return;
        }

        const current = getAgentSessionState(uuid);
        if (current.terminal) {
          stopAgentRunHeartbeat(uuid);
          markAgentSessionState(uuid, {
            status: current.status || "completed",
            closed: false,
            retryable: false,
            disconnectedAt: Date.now(),
          });
          return;
        }
        markAgentSessionState(uuid, {
          status: "disconnected",
          closed: false,
          retryable: true,
          disconnectedAt: Date.now(),
        });
        emitAgentTransportEvent(
          uuid,
          "agent.invocation.disconnected",
          "observed",
          invocation
        );
      });

      bridge.checkBailCommand = (data) => {
        const content = safeJsonParse(data)?.feedback;
        if (WEBSOCKET_BAIL_COMMANDS.includes(content)) {
          bridge.__clientStopped = true;
          agentHandler.log(
            `User invoked bail command while processing. Closing session now.`
          );
          agentHandler.aibitat?.abort?.();
          bridge.close();
          return;
        }
      };

      const durableReplay = await loadDurableAgentSession(uuid, lastEventSeq);
      const replayEvents = durableReplay.events;
      if (isResume || lastEventSeq > 0) {
        socket.send(
          JSON.stringify({
            type: "agentReplayStart",
            latestSeq: durableReplay.state.latestSeq || 0,
          })
        );
        for (const event of replayEvents) {
          if (socket.readyState !== 1) break;
          socket.send(JSON.stringify(event.payload));
        }
        socket.send(
          JSON.stringify({
            type: "agentReplayEnd",
            latestSeq: durableReplay.state.latestSeq || 0,
          })
        );
        emitAgentTransportEvent(
          uuid,
          "agent.invocation.replayed",
          "recovered",
          invocation
        );
      }

      if (session.started) return;
      session.started = true;

      await Telemetry.sendTelemetry("agent_chat_started");
      await agentHandler.createAIbitat({ socket: bridge });
      await agentHandler.startAgentCluster();
    } catch (e) {
      console.error(e.message, e);
      stopAgentRunHeartbeat(uuid);
      socket?.send(JSON.stringify({ type: "wssFailure", content: e.message }));
      socket.close();
    }
  });
}

module.exports = {
  agentRuntimeSnapshot,
  agentWebsocket,
  drainAgentRuntime,
  cancelAgentInvocation,
  submitAgentInvocationAction,
  streamAgentInvocation,
};
