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

const Workspace = DataAccessCenter.workspace;
const WorkspaceThread = DataAccessCenter.workspaceThread;
const IOSPushToken = DataAccessCenter.iosPushToken;
const SyncEvent = DataAccessCenter.syncEvent;
const SyncV2 = DataAccessCenter.syncV2;
const {
  syncV2CohortEnabled,
  syncV2Enabled,
  syncV2RetentionMs,
} = require("../utils/syncV2/config");
const {
  threadFingerprintManifestForRequest,
} = require("../utils/syncV2/threadFingerprintManifest");
const { runMutationBatch } = require("../utils/syncV2/mutationBatch");
const { subscribeToBroadcastEvents } = require("../utils/broadcast");
const { classifyNodeKey } = require("../utils/syncV2/nodeRegistry");
const {
  authoritativeChangedPaths,
  mutationReceiptId,
  mutationRequestHash,
  validateProjectedPayload,
} = require("../utils/syncV2/mutationPolicy");
const {
  isSupportedThreadChatModel,
} = require("../utils/chats/threadChatModel");
const { withCorrelation } = require("../utils/observability/context");
const { metrics } = require("../utils/observability/metrics");
const {
  authenticateRealtimeRequest,
  monitorRealtimePrincipal,
} = require("../utils/authz/realtimePrincipal");

const User = DataAccessCenter.adminSystem.user;
const MutationReceipt = DataAccessCenter.athenaMutationReceipt;

function stripClientDirty(value) {
  if (Array.isArray(value)) return value.map(stripClientDirty);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["dirty", "updatedAt"].includes(key))
      .map(([key, entry]) => [key, stripClientDirty(entry)])
  );
}

function syncMutationError(code, status = 400, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = status;
  Object.assign(error, details);
  return error;
}

async function applySyncV2Mutation(context, mutation = {}) {
  const parsed = classifyNodeKey(mutation.nodeKey);
  if (!parsed) throw syncMutationError("sync_v2_node_not_mutable", 400);
  const mutationId = String(mutation.mutationId || "")
    .trim()
    .slice(0, 160);
  if (!mutationId) throw syncMutationError("sync_v2_mutation_id_required", 400);
  const operations = ["merge", "replace", "delete", "set-add", "set-remove"];
  if (!operations.includes(mutation.operation))
    throw syncMutationError("sync_v2_invalid_operation", 400);
  if (
    !(await SyncV2.canAccessNode({
      nodeKey: parsed.nodeKey,
      userId: context.user.id,
      allowAllWorkspaces: context.allowAllWorkspaces,
    }))
  )
    throw syncMutationError("sync_v2_node_forbidden", 403);

  const baseVersion = Number(mutation.baseVersion);
  if (!Number.isInteger(baseVersion) || baseVersion < 0)
    throw syncMutationError("sync_v2_base_version_required", 400);
  const requestHash = mutationRequestHash({
    ...mutation,
    nodeKey: parsed.nodeKey,
    mutationId,
    baseVersion,
  });
  const receiptKey = mutationReceiptId(mutationId);
  const reservation = await MutationReceipt.reserve({
    userId: context.user.id,
    sourceActionId: receiptKey,
    action: "sync-v2.mutation",
    workspaceId: parsed.ownerType === "workspace" ? parsed.ownerId : undefined,
    threadId: parsed.ownerType === "thread" ? parsed.ownerId : undefined,
    baseVersion,
    requestHash,
    nodeKey: parsed.nodeKey,
    mutationId,
    expiresAt: new Date(Date.now() + syncV2RetentionMs()),
  });
  if (
    reservation.receipt?.requestHash &&
    reservation.receipt.requestHash !== requestHash
  )
    throw syncMutationError("sync_v2_idempotency_key_reused", 409);
  if (
    !reservation.created &&
    reservation.receipt?.status === "completed" &&
    reservation.receipt?.result
  )
    return { ...reservation.receipt.result, replayed: true };

  if (!reservation.created && reservation.receipt?.status === "failed")
    throw syncMutationError(
      reservation.receipt.errorCode || "sync_v2_mutation_failed",
      409
    );

  try {
    const replay = await SyncV2.mutationReplay({
      nodeKey: parsed.nodeKey,
      mutationId,
    });
    if (replay) {
      if (replay.compensated) {
        throw syncMutationError("state_version_conflict", 409, {
          current: replay.descriptor,
          requiresFullSync: false,
          conflictReason: "mutation_compensated",
        });
      }
      await MutationReceipt.complete({
        userId: context.user.id,
        sourceActionId: receiptKey,
        leaseOwner: reservation.leaseOwner,
        resource: { nodeKey: parsed.nodeKey },
        resultVersion: replay.descriptor?.stateVersion,
        result: replay,
      });
      return replay;
    }
    const pendingAgeMs =
      Date.now() - new Date(reservation.receipt?.updatedAt || 0).getTime();
    if (
      !reservation.created &&
      reservation.receipt?.status === "pending" &&
      Number.isFinite(pendingAgeMs) &&
      pendingAgeMs < 30_000
    )
      throw syncMutationError("sync_v2_mutation_in_progress", 425);
    if (!reservation.claimed && !reservation.created)
      throw syncMutationError("sync_v2_mutation_in_progress", 425);
    const changedPaths = authoritativeChangedPaths(mutation);
    const syncContext = {
      nodeKey: parsed.nodeKey,
      baseVersion,
      changedPaths,
      mutationId,
      originClientId: context.client?.clientId || null,
    };
    let authoritativeProjection = null;

    if (parsed.kind === "user-preferences") {
      if (mutation.operation === "delete") {
        await DataAccessCenter.userState.delete({
          userId: context.user.id,
          namespace: parsed.namespace,
          scope: parsed.scope,
          syncContext,
        });
      } else {
        const saved = await DataAccessCenter.userState.upsertMany({
          userId: context.user.id,
          states: [
            {
              namespace: parsed.namespace,
              scope: parsed.scope,
              mutationOperation: mutation.operation,
              mutationPayload: stripClientDirty(mutation.payload),
              baseVersion,
              changedPaths,
              mutationId,
            },
          ],
          syncContext,
        });
        const state = Array.isArray(saved) ? saved[0] || null : null;
        if (state) {
          authoritativeProjection = {
            namespace: state.namespace,
            scope: state.scope,
            schemaVersion: state.version,
            value: state.value,
          };
        }
      }
    } else if (parsed.kind === "user-profile") {
      if (mutation.operation !== "merge")
        throw syncMutationError("sync_v2_operation_not_supported", 400);
      const validation = validateProjectedPayload(
        parsed.kind,
        mutation.payload
      );
      if (validation.error)
        throw syncMutationError(validation.error, 400, {
          unsupportedFields: validation.unsupported || [],
        });
      const updates = validation.payload;
      const result = await User.update(context.user.id, updates, syncContext);
      if (!result.success) {
        if (result.code === "state_version_conflict")
          throw syncMutationError("state_version_conflict", 409, result);
        throw syncMutationError(result.error || "sync_v2_mutation_failed", 422);
      }
    } else if (parsed.kind === "workspace-metadata") {
      if (mutation.operation !== "merge")
        throw syncMutationError("sync_v2_operation_not_supported", 400);
      const validation = validateProjectedPayload(
        parsed.kind,
        mutation.payload
      );
      if (validation.error)
        throw syncMutationError(validation.error, 400, {
          unsupportedFields: validation.unsupported || [],
        });
      const { workspace, message } = await Workspace.update(
        parsed.ownerId,
        validation.payload,
        syncContext
      );
      if (!workspace || message)
        throw syncMutationError(message || "sync_v2_mutation_failed", 422);
    } else if (parsed.kind === "thread-metadata") {
      if (mutation.operation !== "merge")
        throw syncMutationError("sync_v2_operation_not_supported", 400);
      const validation = validateProjectedPayload(
        parsed.kind,
        mutation.payload
      );
      if (validation.error)
        throw syncMutationError(validation.error, 400, {
          unsupportedFields: validation.unsupported || [],
        });
      if (
        Object.prototype.hasOwnProperty.call(validation.payload, "chatModel") &&
        !isSupportedThreadChatModel(validation.payload.chatModel)
      )
        throw syncMutationError("sync_v2_unsupported_thread_chat_model", 400);
      const current = await WorkspaceThread.get({
        OR: [{ user_id: context.user.id }, { user_id: null }],
        id: parsed.ownerId,
      });
      if (!current) throw syncMutationError("sync_v2_node_not_found", 404);
      const { thread, message } = await WorkspaceThread.update(
        current,
        validation.payload,
        syncContext
      );
      if (!thread || message)
        throw syncMutationError(message || "sync_v2_mutation_failed", 422);
    } else {
      throw syncMutationError("sync_v2_node_not_mutable", 400);
    }

    const applied = await SyncV2.mutationReplay({
      nodeKey: parsed.nodeKey,
      mutationId,
    });
    const result = applied
      ? {
          ...applied,
          replayed: false,
          ...(authoritativeProjection
            ? { projection: authoritativeProjection }
            : {}),
        }
      : {
          replayed: false,
          descriptor: (
            await SyncV2.batchGet({
              userId: context.user.id,
              allowAllWorkspaces: context.allowAllWorkspaces,
              nodes: [{ nodeKey: parsed.nodeKey }],
            })
          )[0]?.descriptor,
          ...(authoritativeProjection
            ? { projection: authoritativeProjection }
            : {}),
        };
    await MutationReceipt.complete({
      userId: context.user.id,
      sourceActionId: receiptKey,
      leaseOwner: reservation.leaseOwner,
      resource: { nodeKey: parsed.nodeKey },
      resultVersion: result.descriptor?.stateVersion,
      result,
    });
    return result;
  } catch (error) {
    if (reservation.claimed && error?.code !== "mutation_receipt_lease_lost") {
      const deterministic =
        Number.isInteger(Number(error?.httpStatus)) &&
        Number(error.httpStatus) >= 400 &&
        Number(error.httpStatus) < 500;
      const settle = deterministic
        ? MutationReceipt.fail({
            userId: context.user.id,
            sourceActionId: receiptKey,
            leaseOwner: reservation.leaseOwner,
            errorCode: error?.code || "sync_v2_mutation_failed",
          })
        : MutationReceipt.release({
            userId: context.user.id,
            sourceActionId: receiptKey,
            leaseOwner: reservation.leaseOwner,
            errorCode: error?.code || "sync_v2_mutation_retry_required",
          });
      await settle.catch((settleError) => {
        console.error("[SyncCenter] failed to settle mutation receipt", {
          mutationId,
          nodeKey: parsed.nodeKey,
          code: settleError?.code || "receipt_settlement_failed",
        });
      });
    }
    throw error;
  }
}

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
        response.status(error?.httpStatus || 500).json({
          success: false,
          error:
            error?.code === "database_operation_failed"
              ? "database_operation_failed"
              : "sync_failed",
        });
      }
    }
  };
}

async function syncV2RequestContext(request, response) {
  if (!syncV2Enabled()) {
    response.status(404).json({ success: false, error: "sync_v2_disabled" });
    return null;
  }
  if (!(await SyncV2.schemaReady())) {
    response.status(503).json({
      success: false,
      error: "sync_v2_schema_unavailable",
    });
    return null;
  }
  const user = await userFromSession(request, response);
  if (!user?.id) {
    response.status(401).json({ success: false, error: "unauthorized" });
    return null;
  }
  const client = getClientContext(request, { user });
  if (
    !syncV2CohortEnabled({
      userId: user.id,
      clientId: client?.clientId || "legacy",
      domain: "core",
    })
  ) {
    response.status(404).json({
      success: false,
      error: "sync_v2_cohort_unavailable",
    });
    return null;
  }
  return {
    user,
    client,
    allowAllWorkspaces:
      !multiUserMode(response) || ["admin", "owner"].includes(user.role),
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

function sendSocket(socket, payload) {
  if (!socket || socket.readyState !== 1) return false;
  try {
    socket.send(JSON.stringify(payload));
    metrics.realtimeMessages.inc({
      transport: "websocket",
      direction: "outbound",
      type: String(payload?.type || "unknown").slice(0, 64),
    });
    return true;
  } catch {
    return false;
  }
}

async function authenticateBroadcastRequest(request, socket) {
  try {
    const principal = await authenticateRealtimeRequest({
      request,
      purpose: "broadcast",
      authoritative: true,
    });
    return {
      principal,
      user: principal.user,
      userId: principal.user?.id ?? null,
      clientContext:
        principal.clientContext ||
        getClientContext(request, { user: principal.user }),
    };
  } catch (error) {
    socket.close(1008, error.code || "auth_required");
    return null;
  }
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
      "replaceSubscriptions",
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
    "/sync/v2/manifest",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    asyncEndpoint(async (request, response) => {
      const context = await syncV2RequestContext(request, response);
      if (!context) return;
      const manifest = await SyncV2.manifestForUser({
        userId: context.user.id,
        allowAllWorkspaces: context.allowAllWorkspaces,
        knownManifestHash: String(request.query?.manifestHash || "").slice(
          0,
          96
        ),
      });
      response.status(200).json({
        success: true,
        protocolVersion: 2,
        generatedAt: new Date().toISOString(),
        ...manifest,
      });
    })
  );

  app.post(
    "/sync/v2/nodes:batchGet",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    asyncEndpoint(async (request, response) => {
      const context = await syncV2RequestContext(request, response);
      if (!context) return;
      const nodes = reqBody(request)?.nodes;
      if (!Array.isArray(nodes) || nodes.length > 100) {
        response.status(400).json({
          success: false,
          error: "sync_v2_invalid_node_batch",
        });
        return;
      }
      const results = await SyncV2.batchGet({
        userId: context.user.id,
        allowAllWorkspaces: context.allowAllWorkspaces,
        nodes,
      });
      response.status(200).json({ success: true, nodes: results });
    })
  );

  app.post(
    "/sync/v2/mutations:batch",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    asyncEndpoint(async (request, response) => {
      const context = await syncV2RequestContext(request, response);
      if (!context) return;
      const mutations = reqBody(request)?.mutations;
      if (
        !Array.isArray(mutations) ||
        !mutations.length ||
        mutations.length > 50
      ) {
        return response.status(400).json({
          success: false,
          error: "sync_v2_invalid_mutation_batch",
        });
      }
      const settled = await runMutationBatch(
        mutations,
        async (mutation) => await applySyncV2Mutation(context, mutation)
      );
      const results = settled.map((entry, index) => {
        const mutation = mutations[index];
        if (entry.status === "fulfilled") {
          return {
            mutationId: mutation?.mutationId || null,
            nodeKey: mutation?.nodeKey || null,
            success: true,
            ...entry.value,
          };
        }
        const error = entry.reason || {};
        return {
          mutationId: mutation?.mutationId || null,
          nodeKey: mutation?.nodeKey || null,
          success: false,
          status:
            error.httpStatus ||
            (error.code === "state_version_conflict" ? 409 : 400),
          error: error.code || error.message || "sync_v2_mutation_failed",
          expectedVersion: error.expectedVersion,
          current: error.current || error.syncNode || null,
          requiresFullSync: error.requiresFullSync === true,
          conflictReason: error.conflictReason || null,
          unsupportedFields: error.unsupportedFields || [],
        };
      });
      response.status(200).json({
        success: results.every((result) => result.success),
        results,
      });
    })
  );

  app.patch(
    "/sync/v2/nodes/:nodeKey",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    asyncEndpoint(async (request, response) => {
      const context = await syncV2RequestContext(request, response);
      if (!context) return;
      const body = reqBody(request) || {};
      const mutation = {
        ...body,
        nodeKey: request.params.nodeKey,
        mutationId:
          request.header("Idempotency-Key") || body.mutationId || null,
        baseVersion: Number(request.header("If-Match") ?? body.baseVersion),
        operation: body.operation || "merge",
        payload: body.payload ?? body.patch ?? {},
      };
      try {
        const result = await applySyncV2Mutation(context, mutation);
        response.status(200).json({ success: true, ...result });
      } catch (error) {
        response.status(error.httpStatus || 400).json({
          success: false,
          error: error.code || error.message || "sync_v2_mutation_failed",
          expectedVersion: error.expectedVersion,
          current: error.current || error.syncNode || null,
          requiresFullSync: error.requiresFullSync === true,
          conflictReason: error.conflictReason || null,
          unsupportedFields: error.unsupportedFields || [],
        });
      }
    })
  );

  app.get(
    "/sync/v2/events",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    asyncEndpoint(async (request, response) => {
      const context = await syncV2RequestContext(request, response);
      if (!context) return;
      const result = await SyncV2.eventsAfter({
        userId: context.user.id,
        allowAllWorkspaces: context.allowAllWorkspaces,
        after: request.query?.after,
        limit: request.query?.limit,
      });
      response.status(200).json({ success: true, ...result });
    })
  );

  app.post(
    "/sync/v2/cursor",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    asyncEndpoint(async (request, response) => {
      const context = await syncV2RequestContext(request, response);
      if (!context) return;
      if (!context.client?.clientId) {
        response.status(400).json({
          success: false,
          error: "sync_v2_client_identity_required",
        });
        return;
      }
      const lastAppliedSeq = Number(reqBody(request)?.lastAppliedSeq);
      if (!Number.isInteger(lastAppliedSeq) || lastAppliedSeq < 0) {
        response.status(400).json({
          success: false,
          error: "sync_v2_invalid_cursor",
        });
        return;
      }
      const cursor = await SyncV2.updateCursor({
        userId: context.user.id,
        clientId: context.client.clientId,
        platform: context.client.platform,
        lastAppliedSeq,
      });
      response.status(200).json({
        success: true,
        lastAppliedSeq: cursor.lastAppliedSeq,
      });
    })
  );

  app.get(
    "/sync/v2/stream",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      const context = await syncV2RequestContext(request, response);
      if (!context) return;
      setSseTransportHeaders(response, { "Access-Control-Allow-Origin": "*" });
      response.flushHeaders?.();
      const buffered = [];
      let replaying = true;
      const writeEvent = (event) => {
        const syncEvent = event?.payload?.syncV2;
        if (!syncEvent?.seq) return;
        metrics.realtimeMessages.inc({
          transport: "sse",
          direction: "outbound",
          type: "syncV2.event",
        });
        response.write(`id: ${Number(syncEvent.seq)}\n`);
        writeResponseChunk(response, {
          type: "syncV2.event",
          event: syncEvent,
        });
      };
      const unsubscribe = subscribeToBroadcastEvents((event) => {
        if (
          !syncEventVisibleToUser(
            event,
            context.user.id,
            context.client?.clientId
          )
        )
          return;
        if (replaying) buffered.push(event);
        else writeEvent(event);
      });
      const lastEventId =
        request.header("Last-Event-ID") || request.query?.after || null;
      const replay = await SyncV2.eventsAfter({
        userId: context.user.id,
        allowAllWorkspaces: context.allowAllWorkspaces,
        after: lastEventId,
        limit: 200,
      });
      writeResponseChunk(response, {
        type: "syncV2.ready",
        checkpointSeq: replay.checkpointSeq,
        requiresFullSync: replay.requiresFullSync,
        hasMore: replay.hasMore,
        nextSeq: replay.nextSeq,
      });
      for (const event of replay.events) {
        response.write(`id: ${Number(event.seq)}\n`);
        writeResponseChunk(response, { type: "syncV2.event", event });
      }
      replaying = false;
      for (const event of buffered) writeEvent(event);
      buffered.length = 0;
      const heartbeat = setInterval(() => {
        if (!response.destroyed && !response.writableEnded)
          writeResponseChunk(response, { type: "heartbeat" });
      }, 25_000);
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      request.once("close", cleanup);
      response.once("close", cleanup);
    }
  );

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
        platform: clientContext.platform,
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
      const threads = await threadFingerprintManifestForRequest({
        userId: user?.id || null,
        requireMembership: multiUserMode(response),
        requests,
      });
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
    const stopPrincipalMonitor = monitorRealtimePrincipal({ request, socket });

    const connection = broadcastCenter.registerConnection({
      socket,
      userId: auth.userId,
      clientId: auth.clientContext?.clientId || null,
      platform: auth.clientContext?.platform || null,
    });
    socket.once("close", stopPrincipalMonitor);
    socket.once("error", stopPrincipalMonitor);

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
        platform: connection.platform,
        lastEventId: queryLastEventId,
        subscriptions: [...connection.subscriptions.values()],
      });
      sendReplay(connection, replay);
    }

    socket.on("message", (message) => {
      void withCorrelation(request.athenaTraceContext || {}, async () => {
        const payload = await verifiedSocketPayload(request, socket, message);
        if (!payload) return;
        const inboundMetricType = [
          "hello",
          "resume",
          "subscribe",
          "unsubscribe",
          "replaceSubscriptions",
          "ack",
          "ping",
        ].includes(payload.type)
          ? payload.type
          : "unknown";
        metrics.realtimeMessages.inc({
          transport: "websocket",
          direction: "inbound",
          type: inboundMetricType,
        });
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
                platform: connection.platform,
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
          case "replaceSubscriptions": {
            const subscriptions = broadcastCenter.replaceSubscriptions(
              connection,
              payload.scopes || payload.subscriptions || []
            );
            sendSocket(socket, {
              type: "broadcast.subscriptionsReplaced",
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
      }).catch((error) => {
        console.error("[Broadcast] message handling failed", {
          code: error?.code || "broadcast_message_failed",
          requestId: request.athenaTraceContext?.requestId || null,
          traceId: request.athenaTraceContext?.traceId || null,
        });
        sendSocket(socket, {
          type: "broadcast.error",
          error: "message_handling_failed",
        });
      });
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

module.exports = {
  syncCenterEndpoints,
  __test: { applySyncV2Mutation },
};
