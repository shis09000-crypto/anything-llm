const { userFromSession } = require("../utils/http");
const { DataAccessCenter } = require("../utils/dataAccess");
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
const { broadcastCenter } = require("../utils/broadcast");
const { getClientContext } = require("../utils/clientIdentity");
const { reqBody, multiUserMode } = require("../utils/http");
const {
  configuration: apnsConfiguration,
} = require("../utils/nativePush/apnsProvider");
const {
  ensureSecureWebSocketRequest,
} = require("../utils/security/transportSecurity");
const {
  verifySignedWebSocketMessage,
  signingErrorCode,
  signingWarnOnly,
} = require("../utils/requestSigning");

const SystemSettings = DataAccessCenter.adminSystem;
const Workspace = DataAccessCenter.workspace;
const WorkspaceThread = DataAccessCenter.workspaceThread;
const IOSPushToken = DataAccessCenter.iosPushToken;
const SyncEvent = DataAccessCenter.syncEvent;

function asyncEndpoint(handler) {
  return async (request, response) => {
    try {
      await handler(request, response);
    } catch (error) {
      console.error("[SyncCenter] endpoint failed", {
        path: request.path,
        code: error?.code || "sync_endpoint_failed",
      });
      if (!response.headersSent) {
        response.status(500).json({ success: false, error: "sync_failed" });
      }
    }
  };
}

function requireNativeSignedRequest(request, response) {
  const clientContext = getClientContext(request, {
    user: response.locals?.user || null,
  });
  if (
    !clientContext?.clientId ||
    clientContext.legacy ||
    !request.signedRequest
  ) {
    response.status(401).json({
      success: false,
      error: "native_signed_request_required",
    });
    return null;
  }
  return clientContext;
}

function normalizeFingerprintRequests(value = []) {
  if (!Array.isArray(value)) return null;
  const normalized = value
    .slice(0, 31)
    .map((item) => ({
      workspaceSlug: String(item?.workspaceSlug || "").trim(),
      threadSlug: String(item?.threadSlug || "").trim(),
      fingerprint: item?.fingerprint
        ? String(item.fingerprint).trim().slice(0, 128)
        : null,
    }))
    .filter((item) => item.workspaceSlug && item.threadSlug);
  if (normalized.length > 30 || normalized.length !== value.length) return null;
  return normalized;
}

async function fingerprintManifestForRequest(response, user, requests) {
  const workspaceSlugs = [
    ...new Set(requests.map((item) => item.workspaceSlug)),
  ];
  const workspaces = [];
  for (const slug of workspaceSlugs) {
    const workspace = multiUserMode(response)
      ? await Workspace.getWithUser(user, { slug })
      : await Workspace.get({ slug });
    if (workspace) workspaces.push(workspace);
  }
  const workspaceBySlug = new Map(
    workspaces.map((workspace) => [workspace.slug, workspace])
  );
  const foundThreads = [];
  for (const workspace of workspaces) {
    const threadSlugs = requests
      .filter((item) => item.workspaceSlug === workspace.slug)
      .map((item) => item.threadSlug);
    const threads = await WorkspaceThread.where({
      workspace_id: workspace.id,
      user_id: user?.id || null,
      slug: { in: threadSlugs },
    });
    foundThreads.push(...threads);
  }
  const fingerprintRows = await WorkspaceThread.historyFingerprintManifest({
    threads: foundThreads,
    userId: user?.id || null,
  });
  const fingerprintByThreadId = new Map(
    fingerprintRows.map((row) => [Number(row.threadId), row])
  );
  const threadByKey = new Map(
    foundThreads.map((thread) => [
      `${thread.workspace_id}:${thread.slug}`,
      thread,
    ])
  );

  return requests.map((requested) => {
    const workspace = workspaceBySlug.get(requested.workspaceSlug);
    const thread = workspace
      ? threadByKey.get(`${workspace.id}:${requested.threadSlug}`)
      : null;
    const fingerprint = thread
      ? fingerprintByThreadId.get(Number(thread.id))
      : null;
    if (!workspace || !thread || !fingerprint) {
      return {
        workspaceSlug: requested.workspaceSlug,
        threadSlug: requested.threadSlug,
        status: "unavailable",
      };
    }
    return {
      workspaceSlug: requested.workspaceSlug,
      threadSlug: requested.threadSlug,
      status:
        requested.fingerprint === fingerprint.historyFingerprint
          ? "unchanged"
          : "changed",
      historyFingerprint: fingerprint.historyFingerprint,
      historyRevision: fingerprint.historyRevision,
      latestChatId: fingerprint.latestChatId,
      latestChatAt:
        fingerprint.latestChatAt?.toISOString?.() ||
        fingerprint.latestChatAt ||
        null,
    };
  });
}

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
    "/sync/events/replay",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    asyncEndpoint(async (request, response) => {
      const user = await userFromSession(request, response);
      const clientContext = requireNativeSignedRequest(request, response);
      if (!clientContext) return;
      const replay = await SyncEvent.replay({
        userId: user?.id ?? null,
        clientId: clientContext.clientId,
        afterEventId: request.query?.afterEventId || null,
        limit: request.query?.limit,
      });
      response.status(200).json({ success: true, ...replay });
    })
  );

  app.post(
    "/sync/thread-fingerprints",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    asyncEndpoint(async (request, response) => {
      const user = await userFromSession(request, response);
      if (!requireNativeSignedRequest(request, response)) return;
      const requests = normalizeFingerprintRequests(reqBody(request)?.threads);
      if (!requests) {
        return response.status(400).json({
          success: false,
          error: "invalid_thread_fingerprint_request",
        });
      }
      const threads = await fingerprintManifestForRequest(
        response,
        user,
        requests
      );
      response.status(200).json({
        success: true,
        checkedAt: new Date().toISOString(),
        threads,
      });
    })
  );

  app.post(
    "/native-app/push-token",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    asyncEndpoint(async (request, response) => {
      const user = await userFromSession(request, response);
      const clientContext = requireNativeSignedRequest(request, response);
      if (!clientContext) return;
      if (!user?.id) {
        return response.status(409).json({
          success: false,
          error: "push_requires_user_identity",
        });
      }
      const config = apnsConfiguration();
      if (!config.bundleId) {
        return response.status(503).json({
          success: false,
          error: "apns_bundle_not_configured",
        });
      }
      try {
        await IOSPushToken.register({
          userId: user.id,
          clientId: clientContext.clientId,
          deviceToken: reqBody(request)?.deviceToken,
          environment: config.environment,
          bundleId: config.bundleId,
          appVersion: request.header("X-Athena-App-Version"),
        });
      } catch (error) {
        if (error?.message === "invalid_device_token") {
          return response.status(400).json({
            success: false,
            error: "invalid_device_token",
          });
        }
        throw error;
      }
      response.status(200).json({ success: true });
    })
  );

  app.delete(
    "/native-app/push-token",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    asyncEndpoint(async (request, response) => {
      const user = await userFromSession(request, response);
      const clientContext = requireNativeSignedRequest(request, response);
      if (!clientContext) return;
      if (user?.id) {
        await IOSPushToken.revoke({
          userId: user.id,
          clientId: clientContext.clientId,
        });
      }
      response.status(200).json({ success: true });
    })
  );

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
      const replay = await broadcastCenter.replayDurable({
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
            const replay = await broadcastCenter.replayDurable({
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
