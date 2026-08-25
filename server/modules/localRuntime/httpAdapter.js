const { validatedRequest } = require("../../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../../utils/middleware/multiUserProtected");
const { userFromSession } = require("../../utils/http");
const { getClientContext } = require("../../utils/clientIdentity");
const {
  issueSensitiveSession,
  validateSensitiveSessionForRequest,
} = require("../../utils/authz/sensitiveSessions");
const {
  validateReauthToken,
  consumeReauthToken,
} = require("../../utils/authz/reauthTokens");
const {
  authSessionFingerprintFromRequest,
} = require("../../utils/authz/vaultAccessGrants");
const { localRuntimeCenter } = require("../../utils/localRuntime/runtime");
const {
  LOCAL_RUNTIME_CAPABILITIES,
} = require("../../utils/localRuntime/contracts");
const {
  normalizeCapabilities,
  normalizeRoots,
} = require("../../utils/localRuntime/policy");
const {
  dispatchLocalRuntime,
  externalCenterEnabled,
} = require("../../utils/localRuntime/client");
const RESOURCE_TYPE = "local-runtime-control";

function route(handler) {
  return async (request, response) => {
    try {
      const user = await userFromSession(request, response);
      if (!user?.id)
        return response
          .status(401)
          .json({ success: false, error: "authentication_required" });
      const result = await handler({ request, response, user });
      if (!response.headersSent) response.json({ success: true, result });
    } catch (error) {
      response.status(Number(error?.httpStatus) || 500).json({
        success: false,
        error: String(
          error?.code || error?.message || "local_runtime_request_failed"
        )
          .replace(/[^a-zA-Z0-9_.:-]/g, "_")
          .slice(0, 160),
        approvalRequired: error?.approvalRequired === true,
      });
    }
  };
}

function sensitiveOwnerGuard(request, response, next) {
  const userId = Number(response.locals?.user?.id);
  const clientId = getClientContext(request)?.clientId;
  const result = validateSensitiveSessionForRequest(request, {
    userId,
    clientId,
    resourceType: RESOURCE_TYPE,
    resourceId: String(userId),
    ownerScope: `user:${userId}:local-runtime`,
    heartbeat: true,
  });
  if (!result.ok)
    return response.status(403).json({
      success: false,
      error: "sensitive_session_required",
      reason: result.reason || null,
      resource: {
        resourceType: RESOURCE_TYPE,
        resourceId: String(userId),
        ownerScope: `user:${userId}:local-runtime`,
      },
    });
  response.locals.localRuntimeSensitiveSession = result.session;
  next();
}

function localRuntimeEndpoints(app) {
  if (!app) return;
  if (
    process.env.ATHENA_LOCAL_RUNTIME_ENABLED === "true" &&
    !externalCenterEnabled()
  )
    localRuntimeCenter.start();
  const auth = [validatedRequest, flexUserRoleValid([ROLES.all])];
  const sensitive = [...auth, sensitiveOwnerGuard];
  const center = (operation, input = {}, options = {}) =>
    dispatchLocalRuntime(operation, input, {
      idempotencyKey: options.idempotencyKey,
      timeoutMs: options.timeoutMs || 30_000,
    });

  app.post(
    "/local-runtime/session",
    auth,
    route(({ request, user }) => {
      const clientContext = getClientContext(request);
      if (!request.signedRequest?.ok || !clientContext?.clientId)
        throw Object.assign(new Error("client_identity_required"), {
          httpStatus: 401,
        });
      const reauthToken = request.body?.reauthToken;
      const reauth = validateReauthToken(
        reauthToken,
        user.id,
        "local_runtime_control"
      );
      if (!reauth)
        throw Object.assign(new Error("passkey_reauthentication_required"), {
          httpStatus: 401,
        });
      const sensitiveSession = issueSensitiveSession({
        userId: user.id,
        clientId: clientContext.clientId,
        resourceType: RESOURCE_TYPE,
        resourceId: String(user.id),
        ownerScope: `user:${user.id}:local-runtime`,
        method: "local-runtime-passkey",
        requestId:
          request.signedRequest?.requestId ||
          clientContext.requestId ||
          request.communicationRequestId ||
          null,
        sessionFingerprint: authSessionFingerprintFromRequest(request),
      });
      if (!sensitiveSession)
        throw Object.assign(new Error("sensitive_session_issue_failed"), {
          httpStatus: 503,
        });
      consumeReauthToken(reauthToken);
      return { sensitiveSession };
    })
  );

  app.get(
    "/local-runtime/status",
    auth,
    route(async ({ user }) => ({
      runtime: await center("status"),
      devices: await center("listDevices", { ownerUserId: user.id }),
      capabilities: LOCAL_RUNTIME_CAPABILITIES,
    }))
  );
  app.post(
    "/local-runtime/pairing-tickets",
    sensitive,
    route(({ request, user }) =>
      center("issuePairingTicket", {
        ownerUserId: user.id,
        ownerAuthUserId:
          user.auth_user_id || user.authUserId || String(user.id),
        clientId: getClientContext(request)?.clientId || null,
      })
    )
  );
  app.get(
    "/local-runtime/devices",
    auth,
    route(({ user }) => center("listDevices", { ownerUserId: user.id }))
  );
  app.delete(
    "/local-runtime/devices/:deviceId",
    sensitive,
    route(({ request, user }) =>
      center("revokeDevice", {
        ownerUserId: user.id,
        deviceId: request.params.deviceId,
      })
    )
  );
  app.post(
    "/local-runtime/leases",
    sensitive,
    route(({ request, user }) =>
      center("createLease", {
        ownerUserId: user.id,
        ownerAuthUserId:
          user.auth_user_id || user.authUserId || String(user.id),
        deviceId: request.body?.deviceId,
        capabilities: normalizeCapabilities(request.body?.capabilities),
        allowedRoots: normalizeRoots(request.body?.allowedRoots),
        allowedApps: Array.isArray(request.body?.allowedApps)
          ? request.body.allowedApps.map(String).slice(0, 64)
          : [],
        ttlMs: Math.min(
          Number(request.body?.ttlMs) || 24 * 60 * 60_000,
          24 * 60 * 60_000
        ),
      })
    )
  );
  app.get(
    "/local-runtime/leases",
    auth,
    route(({ request, user }) =>
      center("listLeases", {
        ownerUserId: user.id,
        deviceId: request.query.deviceId || null,
      })
    )
  );
  app.delete(
    "/local-runtime/leases/:leaseId",
    sensitive,
    route(({ request, user }) =>
      center("revokeLease", {
        ownerUserId: user.id,
        leaseId: request.params.leaseId,
      })
    )
  );
  app.get(
    "/local-runtime/jobs",
    auth,
    route(({ request, user }) =>
      center("listJobs", {
        ownerUserId: user.id,
        deviceId: request.query.deviceId || null,
      })
    )
  );
  app.get(
    "/local-runtime/jobs/:jobId/events",
    auth,
    route(({ request, user }) =>
      center("jobEvents", {
        ownerUserId: user.id,
        jobId: request.params.jobId,
        afterSequence: request.query.afterSequence,
      })
    )
  );
  app.post(
    "/local-runtime/jobs/:jobId/cancel",
    auth,
    route(({ request, user }) =>
      center("cancel", {
        ownerUserId: user.id,
        jobId: request.params.jobId,
      })
    )
  );
}

function localRuntimeDeviceSocket(app) {
  if (!app?.ws) return;
  if (externalCenterEnabled()) return;
  if (process.env.ATHENA_LOCAL_RUNTIME_ENABLED === "true")
    localRuntimeCenter.start();
  app.ws("/api/local-runtime/device/connect", (socket) => {
    if (process.env.ATHENA_LOCAL_RUNTIME_ENABLED !== "true")
      return socket.close(4005, "local_runtime_disabled");
    void localRuntimeCenter.handleDeviceSocket(socket);
  });
}

module.exports = { localRuntimeDeviceSocket, localRuntimeEndpoints };
