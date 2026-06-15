const { Telemetry } = require("../models/telemetry");
const {
  WorkspaceAgentInvocation,
} = require("../models/workspaceAgentInvocation");
const { AgentHandler } = require("../utils/agents");
const {
  WEBSOCKET_BAIL_COMMANDS,
} = require("../utils/agents/aibitat/plugins/websocket");
const { safeJsonParse } = require("../utils/http");
const { clearInvocationFileAccess } = require("../utils/chats/agents");
const {
  getAgentSessionState,
  markAgentSessionState,
  readAgentSessionEvents,
  recordAgentSessionEvent,
} = require("../utils/agents/agentSessionLedger");

const activeAgentSessions = new Map();

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
    this.handleClarificationResponse = null;
  }

  attach(socket) {
    this.currentSocket = socket;
    markAgentSessionState(this.uuid, {
      status: "running",
      closed: false,
      retryable: true,
      connectedAt: Date.now(),
    });
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
    const nextPayload = record?.payload || payload;
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
}

// Setup listener for incoming messages to relay to socket so it can be handled by agent plugin.
function relayToSocket(message) {
  if (this.handleFeedback) return this?.handleFeedback?.(message);
  if (this.handleToolApproval) return this?.handleToolApproval?.(message);
  if (this.handleClarificationResponse)
    return this?.handleClarificationResponse?.(message);
  this.checkBailCommand(message);
}

function agentWebsocket(app) {
  if (!app) return;

  app.get("/agent-invocation/:uuid/state", async function (request, response) {
    const uuid = String(request.params.uuid);
    const invocation = await WorkspaceAgentInvocation.get({ uuid });
    if (!invocation) {
      return response.status(404).json({
        success: false,
        error: "agent_invocation_not_found",
      });
    }

    return response.status(200).json({
      success: true,
      state: {
        ...getAgentSessionState(uuid),
        closed: !!invocation.closed,
        retryable: !invocation.closed,
      },
    });
  });

  app.ws("/agent-invocation/:uuid", async function (socket, request) {
    const uuid = String(request.params.uuid);
    try {
      const requestedLastSeq = Number(request.query?.lastEventSeq || 0);
      const lastEventSeq = Number.isFinite(requestedLastSeq)
        ? requestedLastSeq
        : 0;
      const isResume = request.query?.resume === "1";
      let session = activeAgentSessions.get(uuid);

      if (isResume && !session) {
        const invocation = await WorkspaceAgentInvocation.get({ uuid });
        if (!invocation || invocation.closed) {
          socket.close();
          return;
        }
      }

      if (!session) {
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
          markAgentSessionState(uuid, {
            status: session.bridge.__clientStopped ? "stopped" : "closed",
            closed: true,
            retryable: false,
            closedAt: Date.now(),
          });
          activeAgentSessions.delete(uuid);
        });
        activeAgentSessions.set(uuid, session);
      }

      const { agentHandler, bridge } = session;
      bridge.attach(socket);

      socket.on("message", (message) => relayToSocket.call(bridge, message));
      socket.on("close", () => {
        bridge.detach(socket);
        if (bridge.__agentFinalClose || bridge.__clientStopped) {
          agentHandler.closeAlert();
          WorkspaceAgentInvocation.close(uuid);
          clearInvocationFileAccess(uuid);
          markAgentSessionState(uuid, {
            status: bridge.__clientStopped ? "stopped" : "closed",
            closed: true,
            retryable: false,
            closedAt: Date.now(),
          });
          activeAgentSessions.delete(uuid);
          return;
        }

        markAgentSessionState(uuid, {
          status: "disconnected",
          closed: false,
          retryable: true,
          disconnectedAt: Date.now(),
        });
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

      const replayEvents = readAgentSessionEvents(uuid, lastEventSeq);
      if (isResume || lastEventSeq > 0) {
        socket.send(
          JSON.stringify({
            type: "agentReplayStart",
            latestSeq: getAgentSessionState(uuid).latestSeq || 0,
          })
        );
        for (const event of replayEvents) {
          if (socket.readyState !== 1) break;
          socket.send(JSON.stringify(event.payload));
        }
        socket.send(
          JSON.stringify({
            type: "agentReplayEnd",
            latestSeq: getAgentSessionState(uuid).latestSeq || 0,
          })
        );
      }

      if (session.started) return;
      session.started = true;

      await Telemetry.sendTelemetry("agent_chat_started");
      await agentHandler.createAIbitat({ socket: bridge });
      await agentHandler.startAgentCluster();
    } catch (e) {
      console.error(e.message, e);
      socket?.send(JSON.stringify({ type: "wssFailure", content: e.message }));
      socket.close();
    }
  });
}

module.exports = { agentWebsocket };
