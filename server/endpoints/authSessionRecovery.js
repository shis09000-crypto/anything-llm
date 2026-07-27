const crypto = require("crypto");
const { reqBody } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  getClientContext,
  getClientRecord,
} = require("../utils/clientIdentity");
const { verifySignedRequest } = require("../utils/requestSigning");
const { resumeUserSessionToken } = require("../utils/sessionIdle");
const { DataAccessCenter } = require("../utils/dataAccess");
const { emitSemanticEvent } = require("../utils/observability/semanticEvents");
const { metrics } = require("../utils/observability/metrics");

const SystemSettings = DataAccessCenter.adminSystem;
const AuthIdentity = DataAccessCenter.adminSystem.authIdentity;
const User = DataAccessCenter.adminSystem.user;
const AuthSession = DataAccessCenter.adminSystem.authSession;
const RealtimeTicket = DataAccessCenter.adminSystem.realtimeTicket;
const RecoveryRateLimit =
  DataAccessCenter.adminSystem.emailVerificationRateLimit;
const RECOVERY_TICKET_TTL_MS = 60_000;
const RECOVERY_RATE_WINDOW_MS = 15 * 60_000;
const RECOVERY_PURPOSE = "session_recovery";
const ALLOWED_SOURCES = new Set(["route-guard", "api", "bootstrap"]);

function compactReason(value, fallback = "session_recovery_unavailable") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .slice(0, 64);
  return normalized || fallback;
}

function recoverySource(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return ALLOWED_SOURCES.has(normalized) ? normalized : "bootstrap";
}

function requestIp(request) {
  const forwarded = request.get?.("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim().slice(0, 128);
  return String(request.ip || request.socket?.remoteAddress || "unknown").slice(
    0,
    128
  );
}

function handleFingerprint(handle) {
  return crypto
    .createHash("sha256")
    .update(String(handle || "missing"))
    .digest("hex")
    .slice(0, 24);
}

async function recoveryRateLimited(request, handle) {
  const ip = requestIp(request);
  const fingerprint = handleFingerprint(handle);
  const specs = [
    { bucketType: "ip", value: ip, limit: 60 },
    { bucketType: "recovery_handle", value: fingerprint, limit: 20 },
    {
      bucketType: "ip_recovery_handle",
      value: `${ip}:${fingerprint}`,
      limit: 12,
    },
  ];
  const blocked = await Promise.all(
    specs.map((spec) =>
      RecoveryRateLimit.hit({
        ...spec,
        purpose: RECOVERY_PURPOSE,
        windowMs: RECOVERY_RATE_WINDOW_MS,
      })
    )
  );
  return blocked.some(Boolean);
}

function noStore(response) {
  response.set("Cache-Control", "no-store");
  response.set("Pragma", "no-cache");
}

function emitRecoveryEvent({
  stage,
  outcome,
  reason,
  source,
  request,
  durationMs = null,
}) {
  const reasonCode = compactReason(reason, outcome === "success" ? "ok" : null);
  metrics.authSessionRecoveryAttempts.inc({
    stage,
    outcome,
    reason: reasonCode,
  });
  emitSemanticEvent({
    eventType: `auth.session_recovery.${stage}`,
    category: "auth",
    severity:
      outcome === "failure"
        ? "error"
        : outcome === "denied"
          ? "warning"
          : "info",
    outcome,
    subject: {
      type: "component",
      component: "auth-session-recovery",
      operation: recoverySource(source),
    },
    stateTransition: {
      from: stage === "completed" ? "recovering" : "session-missing",
      to:
        outcome === "success"
          ? "authenticated"
          : outcome === "started"
            ? "recovering"
            : "login-required",
      reasonCode,
    },
    correlation: {
      requestId: getClientContext(request)?.requestId || null,
      clientId: null,
    },
    metadata: {
      platform: getClientContext(request)?.platform || "unknown",
      ...(durationMs === null ? {} : { durationMs: Math.max(0, durationMs) }),
    },
    sensitivity: "metadata_only",
  });
}

function emitRouteGuardEvent({ stage, reason, request }) {
  const reasonCode = compactReason(reason);
  metrics.authRouteGuardRecovery.inc({
    outcome: stage === "fallback_login" ? "fallback_login" : "recovery_started",
    reason: reasonCode,
  });
  emitSemanticEvent({
    eventType: `auth.route_guard.${stage}`,
    category: "auth",
    severity: stage === "fallback_login" ? "warning" : "info",
    outcome: stage === "fallback_login" ? "denied" : "started",
    subject: {
      type: "component",
      component: "route-guard",
      operation: "session-recovery",
    },
    stateTransition: {
      from: "session-missing",
      to: stage === "fallback_login" ? "login-required" : "recovering",
      reasonCode,
    },
    correlation: {
      requestId: getClientContext(request)?.requestId || null,
      clientId: null,
    },
    metadata: {
      platform: getClientContext(request)?.platform || "unknown",
    },
    sensitivity: "metadata_only",
  });
}

async function activeRecoveryContext({ recoveryHandle, clientId }) {
  const session = await AuthSession.findByRecoveryHandle(recoveryHandle);
  if (!session) return { ok: false, reason: "recovery_binding_missing" };
  const validation = await AuthSession.validate(session.sessionId, {
    authoritative: true,
    subjectType: "user",
    tokenVersion: session.tokenVersion,
  });
  if (!validation.valid) {
    return { ok: false, reason: validation.code || "session_expired" };
  }
  if (!session.authUserId || String(session.clientId || "") !== clientId) {
    return { ok: false, reason: "session_client_mismatch" };
  }

  const authUser = await AuthIdentity.findById(session.authUserId);
  if (!authUser || !(await AuthIdentity.canLoginInCurrentEnvAsync(authUser))) {
    return { ok: false, reason: "account_unavailable" };
  }
  const shadowUser = await AuthIdentity.ensureShadowUser(authUser);
  if (!shadowUser) return { ok: false, reason: "shadow_user_unavailable" };

  const client = await getClientRecord({
    userId: shadowUser.id,
    clientId,
    includeRevoked: true,
  });
  if (!client || client.revokedAt) {
    return { ok: false, reason: "client_revoked" };
  }
  if (!client.publicKey || !client.publicKeyAlgorithm) {
    return { ok: false, reason: "device_key_missing" };
  }
  return { ok: true, session, authUser, shadowUser, client };
}

function denied(response, reason, status = 401) {
  return response.status(status).json({
    success: false,
    error: "session_recovery_denied",
    reasonCode: compactReason(reason),
  });
}

function authSessionRecoveryEndpoints(app) {
  app.post(
    "/auth/session/recovery/enroll",
    [validatedRequest],
    async (request, response) => {
      noStore(response);
      try {
        if (!response.locals.multiUserMode) {
          return response.status(404).json({ success: false });
        }
        const session = response.locals.authSession;
        const user = response.locals.user;
        const context =
          response.locals.clientContext || getClientContext(request, { user });
        if (
          !session?.sessionId ||
          !user?.authUserId ||
          !context?.clientId ||
          context.clientId === "legacy"
        ) {
          return denied(response, "recovery_enrollment_unavailable");
        }
        const enrolled = await AuthSession.enableRecovery(session.sessionId, {
          authUserId: user.authUserId,
          clientId: context.clientId,
        });
        if (!enrolled) {
          return denied(response, "recovery_enrollment_failed");
        }
        return response.status(200).json({
          success: true,
          recoveryHandle: enrolled.recoveryHandle,
          expiresAt: enrolled.expiresAt,
        });
      } catch (error) {
        emitRecoveryEvent({
          stage: "failed",
          outcome: "failure",
          reason: error?.code || "recovery_enrollment_failed",
          source: "bootstrap",
          request,
        });
        return response.status(503).json({
          success: false,
          error: "session_recovery_unavailable",
          retryable: true,
        });
      }
    }
  );

  app.post("/auth/session/recovery/start", async (request, response) => {
    noStore(response);
    const body = reqBody(request) || {};
    const source = recoverySource(body.source);
    const recoveryHandle = String(body.recoveryHandle || "").trim();
    const clientId = String(getClientContext(request)?.clientId || "");
    try {
      if (!(await SystemSettings.isMultiUserMode())) {
        return response.status(404).json({ success: false });
      }
      if (
        !recoveryHandle ||
        recoveryHandle.length > 256 ||
        !clientId ||
        clientId === "legacy"
      ) {
        if (source === "route-guard") {
          emitRouteGuardEvent({
            stage: "fallback_login",
            reason: "recovery_binding_missing",
            request,
          });
        }
        return denied(response, "recovery_binding_missing");
      }
      if (await recoveryRateLimited(request, recoveryHandle)) {
        response.set("Retry-After", "60");
        emitRecoveryEvent({
          stage: "denied",
          outcome: "denied",
          reason: "rate_limited",
          source,
          request,
        });
        return denied(response, "rate_limited", 429);
      }

      const resolved = await activeRecoveryContext({
        recoveryHandle,
        clientId,
      });
      if (!resolved.ok) {
        emitRecoveryEvent({
          stage: "denied",
          outcome: "denied",
          reason: resolved.reason,
          source,
          request,
        });
        if (source === "route-guard") {
          emitRouteGuardEvent({
            stage: "fallback_login",
            reason: resolved.reason,
            request,
          });
        }
        return denied(response, resolved.reason);
      }

      const ticket = crypto.randomBytes(32).toString("base64url");
      const expiresAt = Date.now() + RECOVERY_TICKET_TTL_MS;
      await RealtimeTicket.issue({
        ticket,
        entry: {
          purpose: RECOVERY_PURPOSE,
          appEnv: process.env.NODE_ENV || "production",
          resourceId: "auth-session-recovery",
          claims: {
            authUserId: resolved.authUser.id,
            shadowUserId: resolved.shadowUser.id,
            sessionId: resolved.session.sessionId,
            clientId,
            source,
          },
          multiUser: true,
          clientId,
          expiresAt,
        },
      });
      emitRecoveryEvent({
        stage: "started",
        outcome: "started",
        reason: "challenge_issued",
        source,
        request,
      });
      if (source === "route-guard") {
        emitRouteGuardEvent({
          stage: "recovery_started",
          reason: "missing_session_storage",
          request,
        });
      }
      return response.status(200).json({
        success: true,
        recoveryTicket: ticket,
        expiresAt,
        signaturePolicy: resolved.client.pqPublicKey
          ? "registered-hybrid"
          : "registered-device",
      });
    } catch (error) {
      emitRecoveryEvent({
        stage: "failed",
        outcome: "failure",
        reason: error?.code || "recovery_start_failed",
        source,
        request,
      });
      return response.status(503).json({
        success: false,
        error: "session_recovery_unavailable",
        retryable: true,
      });
    }
  });

  app.post("/auth/session/recovery/finish", async (request, response) => {
    noStore(response);
    const startedAt = Date.now();
    const body = reqBody(request) || {};
    const ticket = String(body.recoveryTicket || "").trim();
    let source = "bootstrap";
    try {
      const entry = ticket ? await RealtimeTicket.consume(ticket) : null;
      if (
        !entry ||
        entry.purpose !== RECOVERY_PURPOSE ||
        entry.resourceId !== "auth-session-recovery"
      ) {
        emitRecoveryEvent({
          stage: "denied",
          outcome: "denied",
          reason: "challenge_invalid_or_consumed",
          source,
          request,
          durationMs: Date.now() - startedAt,
        });
        return denied(response, "challenge_invalid_or_consumed");
      }
      source = recoverySource(entry.claims?.source);
      const clientId = String(getClientContext(request)?.clientId || "");
      if (!clientId || clientId !== String(entry.claims?.clientId || "")) {
        emitRecoveryEvent({
          stage: "denied",
          outcome: "denied",
          reason: "session_client_mismatch",
          source,
          request,
          durationMs: Date.now() - startedAt,
        });
        return denied(response, "session_client_mismatch");
      }

      const sessionResult = await AuthSession.validate(
        entry.claims?.sessionId,
        {
          authoritative: true,
          subjectType: "user",
        }
      );
      const session = sessionResult.session;
      if (
        !sessionResult.valid ||
        !session ||
        Number(session.authUserId) !== Number(entry.claims?.authUserId) ||
        String(session.clientId || "") !== clientId
      ) {
        const reason = sessionResult.code || "session_expired";
        emitRecoveryEvent({
          stage: "denied",
          outcome: "denied",
          reason,
          source,
          request,
          durationMs: Date.now() - startedAt,
        });
        return denied(response, reason);
      }

      const authUser = await AuthIdentity.findById(session.authUserId);
      if (
        !authUser ||
        !(await AuthIdentity.canLoginInCurrentEnvAsync(authUser))
      ) {
        return denied(response, "account_unavailable");
      }
      const shadowUser = await AuthIdentity.ensureShadowUser(authUser);
      if (
        !shadowUser ||
        Number(shadowUser.id) !== Number(entry.claims?.shadowUserId)
      ) {
        return denied(response, "shadow_user_unavailable");
      }
      const client = await getClientRecord({
        userId: shadowUser.id,
        clientId,
        includeRevoked: true,
      });
      if (!client || client.revokedAt) {
        return denied(response, "client_revoked");
      }
      if (!client.publicKey || !client.publicKeyAlgorithm) {
        return denied(response, "device_key_missing");
      }

      getClientContext(request, { user: shadowUser });
      const verification = await verifySignedRequest(request);
      if (!verification.ok) {
        const reason = verification.reasonCode || "device_signature_invalid";
        emitRecoveryEvent({
          stage: "denied",
          outcome: "denied",
          reason,
          source,
          request,
          durationMs: Date.now() - startedAt,
        });
        return denied(response, reason);
      }
      if (client.pqPublicKey && verification.postQuantumVerified !== true) {
        emitRecoveryEvent({
          stage: "denied",
          outcome: "denied",
          reason: "post_quantum_signature_required",
          source,
          request,
          durationMs: Date.now() - startedAt,
        });
        return denied(response, "post_quantum_signature_required");
      }

      await AuthSession.touchUserAction(session.sessionId);
      await AuthSession.markRecoveryUsed(session.sessionId);
      const token = resumeUserSessionToken(shadowUser, session);
      const durationMs = Date.now() - startedAt;
      metrics.authSessionRecoveryDuration.observe(
        { outcome: "success" },
        durationMs / 1_000
      );
      emitRecoveryEvent({
        stage: "completed",
        outcome: "success",
        reason: "recovered",
        source,
        request,
        durationMs,
      });
      return response.status(200).json({
        success: true,
        valid: true,
        user: User.filterFields(shadowUser),
        token,
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      metrics.authSessionRecoveryDuration.observe(
        { outcome: "failure" },
        durationMs / 1_000
      );
      emitRecoveryEvent({
        stage: "failed",
        outcome: "failure",
        reason: error?.code || "recovery_finish_failed",
        source,
        request,
        durationMs,
      });
      return response.status(503).json({
        success: false,
        error: "session_recovery_unavailable",
        retryable: true,
      });
    }
  });
}

module.exports = {
  authSessionRecoveryEndpoints,
  _internals: {
    activeRecoveryContext,
    compactReason,
    handleFingerprint,
    recoveryRateLimited,
    recoverySource,
  },
};
