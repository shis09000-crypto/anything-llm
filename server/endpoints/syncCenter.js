const { userFromSession } = require("../utils/http");
const { SystemSettings } = require("../models/systemSettings");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  setSseTransportHeaders,
} = require("../utils/security/transportSecurity");
const { writeResponseChunk } = require("../utils/helpers/chat/responses");
const {
  subscribeToSyncEvents,
  syncEventVisibleToUser,
} = require("../utils/syncCenter");
const {
  broadcastCenter,
} = require("../utils/broadcast");
const {
  getClientContext,
} = require("../utils/clientIdentity");
const {
  ensureSecureWebSocketRequest,
} = require("../utils/security/transportSecurity");
const {
  verifySignedWebSocketMessage,
  signingErrorCode,
  signingWarnOnly,
} = require("../utils/requestSigning");

function sendSocket(socket, payload) {
  if (!socket || socket.readyState !== 1) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function attachQueryAuthHeader(request) {
  const token = Array.isArray(request.query?.token)
    ? request.query.token[0]
    : request.query?.token;
  if (!token || request.headers?.authorization) return;
  request.headers.authorization = `Bearer ${token}`;
}

async function authenticateBroadcastRequest(request, socket) {
  attachQueryAuthHeader(request);
  const user = await userFromSession(request);
  const multiUserMode = await SystemSettings.isMultiUserMode();
  if (multiUserMode && !user) {
    socket.close(1008, "auth_required");
    return null;
  }
  return {
    user,
    userId: user?.id ?? null,
    clientContext: getClientContext(request, { user }),
  };
}

function parseJsonMessage(message) {
  try {
    return JSON.parse(String(message || "{}"));
  } catch {
    return {};
  }
}

async function verifiedSocketPayload(request, socket, message) {
  const parsed = parseJsonMessage(message);
  const isSigned = parsed?.type === "athenaSignedMessage";
  if (!isSigned) return parsed;
  const verification = await verifySignedWebSocketMessage(request, message);
  if (!verification.ok) {
    const fallbackPayload =
      parsed?.payload && typeof parsed.payload === "object"
        ? parsed.payload
        : null;
    const fallbackType = String(fallbackPayload?.type || "");
    const lowRiskBroadcastControl = [
      "hello",
      "resume",
      "subscribe",
      "unsubscribe",
      "ack",
      "ping",
    ].includes(fallbackType);
    if (lowRiskBroadcastControl) {
      sendSocket(socket, {
        type: "broadcast.signatureWarning",
        code: signingErrorCode(verification.reasonCode),
        controlType: fallbackType,
      });
      return fallbackPayload;
    }
    if (!signingWarnOnly()) {
      sendSocket(socket, {
        type: "broadcast.error",
        code: signingErrorCode(verification.reasonCode),
        error: "Signed broadcast message verification failed.",
      });
      socket.close(1008, "invalid_signature");
      return null;
    }
  }
  return verification.payload || {};
}

function sendReplay(connection, events = []) {
  sendSocket(connection.socket, {
    type: "broadcast.replayStart",
    count: events.length,
  });
  for (const event of events) {
    if (connection.socket.readyState !== 1) break;
    connection.send(event);
  }
  sendSocket(connection.socket, {
    type: "broadcast.replayEnd",
    count: events.length,
  });
}

function syncCenterEndpoints(app) {
  if (!app) return;

  app.get(
    "/sync/events",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      const user = await userFromSession(request, response);
      const userId = user?.id ?? null;
      const clientContext = getClientContext(request, { user });

      setSseTransportHeaders(response, {
        "Access-Control-Allow-Origin": "*",
      });
      response.flushHeaders?.();

      writeResponseChunk(response, {
        type: "sync_center_ready",
      });

      const heartbeat = setInterval(() => {
        if (response.destroyed || response.writableEnded) return;
        writeResponseChunk(response, { type: "heartbeat" });
      }, 25_000);

      const unsubscribe = subscribeToSyncEvents((event) => {
        if (!syncEventVisibleToUser(event, userId, clientContext?.clientId))
          return;
        if (response.destroyed || response.writableEnded) return;
        writeResponseChunk(response, event);
      });

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      request.once("close", cleanup);
      response.once("close", cleanup);
    }
  );

  app.ws("/realtime/broadcast", async (socket, request) => {
    if (!ensureSecureWebSocketRequest(request, socket)) return;

    const auth = await authenticateBroadcastRequest(request, socket);
    if (!auth) return;

    const connection = broadcastCenter.registerConnection({
      socket,
      userId: auth.userId,
      clientId: auth.clientContext?.clientId || null,
    });

    sendSocket(socket, {
      type: "broadcast.ready",
      clientId: connection.clientId,
      userId: connection.userId,
    });

    const queryLastEventId = Array.isArray(request.query?.lastEventId)
      ? request.query.lastEventId[0]
      : request.query?.lastEventId;
    if (queryLastEventId) {
      const replay = broadcastCenter.replay({
        userId: connection.userId,
        clientId: connection.clientId,
        lastEventId: queryLastEventId,
        subscriptions: [...connection.subscriptions.values()],
      });
      sendReplay(connection, replay);
    }

    socket.on("message", async (message) => {
      const payload = await verifiedSocketPayload(request, socket, message);
      if (!payload) return;
      switch (payload.type) {
        case "hello":
        case "resume": {
          const subscriptions = Array.isArray(payload.subscriptions)
            ? payload.subscriptions
            : [];
          if (subscriptions.length) {
            broadcastCenter.subscribe(connection, subscriptions);
          }
          if (payload.lastEventId) {
            const replay = broadcastCenter.replay({
              userId: connection.userId,
              clientId: connection.clientId,
              lastEventId: payload.lastEventId,
              subscriptions: [...connection.subscriptions.values()],
            });
            sendReplay(connection, replay);
          }
          sendSocket(socket, {
            type: "broadcast.hello",
            ok: true,
            subscriptions: [...connection.subscriptions.values()],
          });
          return;
        }
        case "subscribe": {
          const subscriptions = broadcastCenter.subscribe(
            connection,
            payload.scopes || payload.subscriptions || []
          );
          sendSocket(socket, {
            type: "broadcast.subscribed",
            subscriptions,
          });
          return;
        }
        case "unsubscribe": {
          const subscriptions = broadcastCenter.unsubscribe(
            connection,
            payload.scopes || payload.subscriptions || []
          );
          sendSocket(socket, {
            type: "broadcast.unsubscribed",
            subscriptions,
          });
          return;
        }
        case "ack": {
          const ok = broadcastCenter.ack(connection, payload.eventId);
          sendSocket(socket, {
            type: "broadcast.ack",
            eventId: payload.eventId,
            ok,
          });
          return;
        }
        case "ping":
          sendSocket(socket, { type: "broadcast.pong", at: Date.now() });
          return;
        default:
          sendSocket(socket, {
            type: "broadcast.error",
            error: "unknown_message_type",
          });
      }
    });

    socket.on("close", () => {
      broadcastCenter.removeConnection(connection);
    });
    socket.on("error", () => {
      broadcastCenter.removeConnection(connection);
    });
  });

  app.get(
    "/realtime/broadcast/debug",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    (_request, response) => {
      if (process.env.NODE_ENV === "production")
        return response.sendStatus(404);
      return response.status(200).json({
        success: true,
        broadcast: broadcastCenter.snapshot(),
      });
    }
  );
}

module.exports = { syncCenterEndpoints };
