const { DataAccessCenter } = require("../utils/dataAccess");
const { reqBody, userFromSession } = require("../utils/http");
const {
  getClientContext,
  recordClientTrustCheckpoint,
} = require("../utils/clientIdentity");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  issueSensitiveSession,
  validateSensitiveSessionForRequest,
} = require("../utils/authz/sensitiveSessions");
const {
  authSessionFingerprintFromRequest,
} = require("../utils/authz/vaultAccessGrants");
const {
  approveRotation,
  keyGovernanceStatus,
  prepareRotation,
  runSecurityPreflight,
} = require("../utils/security/keyLifecycle");
const { executeRotationJob } = require("../utils/security/keyRotation");
const { verifyPassword } = require("../utils/security/passwordCredential");
const { metrics } = require("../utils/observability/metrics");

const KEY_CONTROL_RESOURCE = "key-control";
const KEY_CONTROL_OWNER_SCOPE = "system:key-control";

function keyControlSessionRequired(request, response, next) {
  const userId = Number(response.locals?.user?.id);
  const context = getClientContext(request);
  const result = validateSensitiveSessionForRequest(request, {
    userId,
    clientId: context?.clientId,
    resourceType: KEY_CONTROL_RESOURCE,
    resourceId: "global",
    ownerScope: KEY_CONTROL_OWNER_SCOPE,
  });
  if (!result.ok) {
    response.status(403).json({
      success: false,
      error: "sensitive_session_required",
      reason: result.reason || null,
    });
    return;
  }
  response.locals.keyControlSession = result.session;
  next();
}

function adminGuards({ sensitive = false } = {}) {
  const guards = [validatedRequest, flexUserRoleValid([ROLES.admin])];
  if (sensitive) guards.push(keyControlSessionRequired);
  return guards;
}

function securityKeyEndpoints(app) {
  if (!app) return;

  app.get(
    "/admin/security/keys/status",
    adminGuards(),
    async (request, response) => {
      try {
        const limit = Math.max(
          1,
          Math.min(Number(request.query?.limit) || 50, 200)
        );
        return response.status(200).json({
          success: true,
          ...(await keyGovernanceStatus({ limit })),
        });
      } catch (error) {
        return response.status(503).json({
          success: false,
          error: "key_governance_status_unavailable",
          reason: error?.message || String(error),
        });
      }
    }
  );

  app.post(
    "/admin/security/keys/session",
    adminGuards(),
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const storedUser = await DataAccessCenter.adminSystem.user._get({
          id: Number(user?.id),
        });
        const { currentPassword } = reqBody(request) || {};
        if (
          !storedUser?.password ||
          !(
            await verifyPassword(
              String(currentPassword || ""),
              storedUser.password
            )
          ).valid
        ) {
          return response.status(401).json({
            success: false,
            error: "reauthentication_failed",
          });
        }
        const context = getClientContext(request);
        if (!context?.clientId) {
          return response.status(401).json({
            success: false,
            error: "client_identity_required",
          });
        }
        const sensitiveSession = issueSensitiveSession({
          userId: user.id,
          clientId: context.clientId,
          resourceType: KEY_CONTROL_RESOURCE,
          resourceId: "global",
          ownerScope: KEY_CONTROL_OWNER_SCOPE,
          method: "key-control-password-reauth",
          requestId:
            request.signedRequest?.requestId ||
            context.requestId ||
            request.communicationRequestId ||
            null,
          sessionFingerprint: authSessionFingerprintFromRequest(request),
        });
        await DataAccessCenter.securityKey.appendEvent({
          event: "key_control_session_issued",
          purpose: "server-data-at-rest",
          metadata: { clientIdPresent: true },
          createdBy: user.id,
        });
        return response.status(200).json({ success: true, sensitiveSession });
      } catch (error) {
        return response.status(error.httpStatus || 500).json({
          success: false,
          error: "key_control_session_failed",
          reason: error?.message || String(error),
        });
      }
    }
  );

  app.post(
    "/admin/security/keys/preflight",
    adminGuards({ sensitive: true }),
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        await recordClientTrustCheckpoint(request, {
          action: "key_preflight",
          resourceType: KEY_CONTROL_RESOURCE,
          outcome: "received",
        });
        const result = await runSecurityPreflight({
          runtimeRole: "admin-manual",
        });
        await DataAccessCenter.securityKey.appendEvent({
          event: "key_preflight_requested",
          keyId: result.activeKey?.keyId || null,
          purpose: "server-data-at-rest",
          metadata: { status: result.status },
          createdBy: user?.id || null,
        });
        return response.status(200).json({ success: true, runtime: result });
      } catch (error) {
        return response.status(409).json({
          success: false,
          error: "key_preflight_failed",
          reason: error?.message || String(error),
        });
      }
    }
  );

  app.post(
    "/admin/security/keys/rotations",
    adminGuards({ sensitive: true }),
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const body = reqBody(request) || {};
        const idempotencyKey =
          request.header?.("Idempotency-Key") || body.idempotencyKey;
        if (!idempotencyKey) {
          return response.status(400).json({
            success: false,
            error: "idempotency_key_required",
          });
        }
        const job = await prepareRotation({
          idempotencyKey: String(idempotencyKey).slice(0, 256),
          createdBy: user?.id || null,
        });
        return response.status(202).json({ success: true, job });
      } catch (error) {
        return response.status(409).json({
          success: false,
          error: error?.code || "key_rotation_prepare_failed",
          reason: error?.message || String(error),
        });
      }
    }
  );

  app.get(
    "/admin/security/keys/rotations/:id",
    adminGuards(),
    async (request, response) => {
      const job = await DataAccessCenter.securityKey.rotationJob({
        jobId: request.params.id,
      });
      if (!job) {
        return response
          .status(404)
          .json({ success: false, error: "not_found" });
      }
      const approvals = await DataAccessCenter.securityKey.rotationApprovals({
        jobId: job.jobId,
      });
      return response.status(200).json({ success: true, job, approvals });
    }
  );

  app.post(
    "/admin/security/keys/rotations/:id/approve",
    adminGuards({ sensitive: true }),
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const approvalId =
          request.header?.("Idempotency-Key") ||
          reqBody(request)?.approvalId ||
          request.signedRequest?.requestId;
        const result = await approveRotation({
          jobId: request.params.id,
          approvalId,
          approvedBy: user?.id,
          metadata: {
            clientId: getClientContext(request)?.clientId || null,
            requestId: request.signedRequest?.requestId || null,
          },
        });
        metrics.keyRotationOperations.inc({
          operation: "approve",
          outcome: result.approved ? "approved" : "pending",
        });
        await recordClientTrustCheckpoint(request, {
          action: "key_rotation_approved",
          resourceType: KEY_CONTROL_RESOURCE,
          resourceId: request.params.id,
          outcome: result.approved ? "approved" : "pending",
        });
        return response.status(200).json({ success: true, ...result });
      } catch (error) {
        metrics.keyRotationOperations.inc({
          operation: "approve",
          outcome: "rejected",
        });
        return response.status(409).json({
          success: false,
          error:
            error?.code || error?.message || "key_rotation_approval_failed",
        });
      }
    }
  );

  app.post(
    "/admin/security/keys/rotations/:id/execute",
    adminGuards({ sensitive: true }),
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        await recordClientTrustCheckpoint(request, {
          action: "key_rotation_execution_requested",
          resourceType: KEY_CONTROL_RESOURCE,
          resourceId: request.params.id,
          outcome: "received",
        });
        const job = await executeRotationJob({
          jobId: request.params.id,
          actorUserId: user?.id,
        });
        metrics.keyRotationOperations.inc({
          operation: "execute",
          outcome: "completed",
        });
        return response.status(200).json({ success: true, job });
      } catch (error) {
        metrics.keyRotationOperations.inc({
          operation: "execute",
          outcome: "failed",
        });
        return response.status(409).json({
          success: false,
          error: error?.code || "key_rotation_execution_failed",
          reason: error?.message || String(error),
        });
      }
    }
  );

  app.post(
    "/admin/security/keys/recovery/verify",
    adminGuards({ sensitive: true }),
    async (_request, response) => {
      try {
        const result = await runSecurityPreflight({
          runtimeRole: "recovery-verify",
        });
        return response.status(200).json({ success: true, runtime: result });
      } catch (error) {
        return response.status(409).json({
          success: false,
          error: "key_recovery_verify_failed",
          reason: error?.message || String(error),
        });
      }
    }
  );
}

module.exports = {
  KEY_CONTROL_OWNER_SCOPE,
  KEY_CONTROL_RESOURCE,
  keyControlSessionRequired,
  securityKeyEndpoints,
};
