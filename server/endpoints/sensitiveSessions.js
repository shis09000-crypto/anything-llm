const {
  EventLogRepository: EventLogs,
} = require("../repositories/eventLogRepository");
const { reqBody } = require("../utils/http");
const { getClientContext } = require("../utils/clientIdentity");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  revokeSensitiveSession,
  revokeSensitiveSessions,
  sensitiveSessionSnapshot,
  validateSensitiveSessionForRequest,
} = require("../utils/authz/sensitiveSessions");
const { publishBroadcastEvent } = require("../utils/broadcast");

function currentUserId(response) {
  const id = Number(response?.locals?.user?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function currentClientContext(request) {
  const context = getClientContext(request);
  if (!context?.userId || context.legacy || !context.clientId) return null;
  return context;
}

function sensitiveSessionEndpoints(app) {
  if (!app) return;

  app.post(
    "/sensitive-sessions/heartbeat",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      const context = currentClientContext(request);
      if (!userId || !context || Number(context.userId) !== Number(userId)) {
        return response
          .status(401)
          .json({ success: false, error: "client_identity_required" });
      }
      if (!request.signedRequest?.ok) {
        return response
          .status(401)
          .json({ success: false, error: "invalid_signed_request" });
      }

      const body = reqBody(request) || {};
      const result = validateSensitiveSessionForRequest(request, {
        userId,
        clientId: context.clientId,
        resourceType: body.resourceType || null,
        resourceId: body.resourceId || null,
        ownerScope: body.ownerScope || null,
        heartbeat: true,
      });
      if (!result.ok) {
        return response.status(403).json({
          success: false,
          error: result.error || "sensitive_session_required",
        });
      }
      return response.status(200).json({ success: true });
    }
  );

  app.post(
    "/sensitive-sessions/revoke",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      const context = currentClientContext(request);
      if (!userId || !context || Number(context.userId) !== Number(userId)) {
        return response
          .status(401)
          .json({ success: false, error: "client_identity_required" });
      }
      if (!request.signedRequest?.ok) {
        return response
          .status(401)
          .json({ success: false, error: "invalid_signed_request" });
      }

      const body = reqBody(request) || {};
      const revoked =
        body.sessionId || body.token
          ? revokeSensitiveSession({
              token: body.sessionId || body.token,
              userId,
              clientId: context.clientId,
            })
          : false;
      const revokedCount = revoked ? 1 : 0;
      await EventLogs.logEvent(
        "sensitive_session_revoked",
        { revokedCount },
        userId
      );
      if (revokedCount) {
        publishBroadcastEvent({
          namespace: "sensitiveSession",
          type: "revoked",
          eventPriority: "critical",
          visibility: "client",
          scope: { userId, clientId: context.clientId },
          sourceClientId: context.clientId,
          payload: {
            revokedCount,
            reason: body.reason || "explicit-revoke",
          },
        });
      }
      return response.status(200).json({ success: true, revokedCount });
    }
  );

  app.post(
    "/sensitive-sessions/revoke-scope",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      const context = currentClientContext(request);
      if (!userId || !context || Number(context.userId) !== Number(userId)) {
        return response
          .status(401)
          .json({ success: false, error: "client_identity_required" });
      }
      if (!request.signedRequest?.ok) {
        return response
          .status(401)
          .json({ success: false, error: "invalid_signed_request" });
      }
      const body = reqBody(request) || {};
      const revokedCount = revokeSensitiveSessions({
        userId,
        clientId: context.clientId,
        resourceType: body.resourceType || null,
        resourceId: body.resourceId || null,
        ownerScope: body.ownerScope || null,
      });
      await EventLogs.logEvent(
        "sensitive_session_scope_revoked",
        {
          resourceType: body.resourceType || null,
          hasResourceId: !!body.resourceId,
          hasOwnerScope: !!body.ownerScope,
          revokedCount,
        },
        userId
      );
      if (revokedCount) {
        publishBroadcastEvent({
          namespace: "sensitiveSession",
          type: "revoked",
          eventPriority: "critical",
          visibility: "client",
          scope: { userId, clientId: context.clientId },
          sourceClientId: context.clientId,
          payload: {
            resourceType: body.resourceType || null,
            resourceId: body.resourceId || null,
            ownerScope: body.ownerScope || null,
            revokedCount,
            reason: body.reason || "scope-revoke",
          },
        });
      }
      return response.status(200).json({ success: true, revokedCount });
    }
  );

  app.get(
    "/sensitive-sessions/debug",
    [validatedRequest],
    (request, response) => {
      if (process.env.NODE_ENV === "production")
        return response.sendStatus(404);
      const userId = currentUserId(response);
      const context = currentClientContext(request);
      return response.status(200).json({
        success: true,
        sessions: sensitiveSessionSnapshot({
          userId,
          clientId: context?.clientId || null,
        }),
      });
    }
  );
}

module.exports = { sensitiveSessionEndpoints };
