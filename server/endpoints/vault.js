const {
  EventLogRepository: EventLogs,
} = require("../repositories/eventLogRepository");
const { DataAccessCenter } = require("../utils/dataAccess");
const { reqBody } = require("../utils/http");
const { getClientContext } = require("../utils/clientIdentity");
const {
  consumeReauthToken,
  validateReauthToken,
} = require("../utils/authz/reauthTokens");
const {
  authSessionFingerprintFromRequest,
  issueVaultAccessGrant,
  revokeVaultAccessGrants,
  validateVaultGrantForRequest,
} = require("../utils/authz/vaultAccessGrants");
const {
  issueSensitiveSession,
  revokeSensitiveSessions,
} = require("../utils/authz/sensitiveSessions");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { verifyPassword } = require("../utils/security/passwordCredential");

const User = DataAccessCenter.user;

function currentUserId(response) {
  const id = Number(response?.locals?.user?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function vaultErrorResponse(response, error) {
  const message = String(error?.message || error || "vault_error");
  const status = message.includes("required")
    ? 400
    : message.includes("too_large")
      ? 413
      : 500;
  return response.status(status).json({ success: false, error: message });
}

function logVaultEvent(event, metadata, userId) {
  return EventLogs.logEvent(event, metadata, userId);
}

function currentClientContext(request) {
  const context = getClientContext(request);
  if (!context?.userId || context.legacy || !context.clientId) return null;
  return context;
}

function vaultGrantDeniedResponse(response, result) {
  return response.status(403).json({
    success: false,
    error: result?.error || "vault_access_grant_required",
  });
}

async function requireVaultGrant(request, response, { userId, action }) {
  const context = currentClientContext(request);
  if (!context || Number(context.userId) !== Number(userId)) {
    return {
      ok: false,
      response: response.status(401).json({
        success: false,
        error: "client_identity_required",
      }),
    };
  }
  if (!request.signedRequest?.ok) {
    return {
      ok: false,
      response: response
        .status(401)
        .json({ success: false, error: "invalid_signed_request" }),
    };
  }

  const result = validateVaultGrantForRequest(request, {
    userId,
    clientId: context.clientId,
  });
  if (!result.ok) {
    void logVaultEvent(
      "vault_access_denied",
      {
        action,
        reason: result.error,
        clientId: context.clientId,
      },
      userId
    );
    return {
      ok: false,
      response: vaultGrantDeniedResponse(response, result),
    };
  }
  return { ok: true, context, grant: result.grant || null };
}

async function issueGrantForRequest(request, response, { userId, method }) {
  const context = currentClientContext(request);
  if (!context || Number(context.userId) !== Number(userId)) {
    return response
      .status(401)
      .json({ success: false, error: "client_identity_required" });
  }
  if (!request.signedRequest?.ok) {
    return response
      .status(401)
      .json({ success: false, error: "invalid_signed_request" });
  }

  const grant = issueVaultAccessGrant({
    userId,
    clientId: context.clientId,
    method,
    requestId: request.signedRequest?.requestId || context.requestId || null,
    sessionFingerprint: authSessionFingerprintFromRequest(request),
  });
  if (!grant) {
    return response
      .status(500)
      .json({ success: false, error: "vault_access_grant_unavailable" });
  }

  void logVaultEvent(
    "vault_access_grant_issued",
    {
      method,
      expiresAt: grant.expiresAt,
      signatureVersion: request.signedRequest?.signatureVersion || null,
    },
    userId
  );
  const sensitiveSession = issueSensitiveSession({
    userId,
    clientId: context.clientId,
    resourceType: "vault",
    resourceId: "vault",
    ownerScope: `user:${userId}:vault`,
    method,
    requestId: request.signedRequest?.requestId || context.requestId || null,
    sessionFingerprint: authSessionFingerprintFromRequest(request),
  });

  return response.status(200).json({
    success: true,
    vaultGrant: grant.token,
    sensitiveSession,
    expiresAt: grant.expiresAt,
    ttlMs: grant.ttlMs,
  });
}

function vaultEndpoints(app) {
  if (!app) return;

  app.post(
    "/vault/reauth/password",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      if (!userId) {
        return response
          .status(401)
          .json({ success: false, error: "unauthorized" });
      }

      try {
        const { currentPassword } = reqBody(request) || {};
        const user = await User._get({ id: userId });
        if (
          !user ||
          !(await verifyPassword(String(currentPassword || ""), user.password))
            .valid
        ) {
          void logVaultEvent(
            "vault_reauth_failed",
            { method: "password", reason: "invalid_password" },
            userId
          );
          return response.status(401).json({
            success: false,
            error: "vault_reauth_failed",
          });
        }

        return issueGrantForRequest(request, response, {
          userId,
          method: "password",
        });
      } catch (error) {
        return response.status(error.httpStatus || 500).json({
          success: false,
          error: error?.message || "vault_reauth_failed",
        });
      }
    }
  );

  app.post(
    "/vault/access-grants",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      if (!userId) {
        return response
          .status(401)
          .json({ success: false, error: "unauthorized" });
      }

      const { reauthToken } = reqBody(request) || {};
      const reauth = validateReauthToken(reauthToken, userId, [
        "vault_access",
        "sensitive_memory_reveal",
      ]);
      if (!reauth) {
        void logVaultEvent(
          "vault_reauth_failed",
          { method: "reauth_token", reason: "invalid_reauth_token" },
          userId
        );
        return response
          .status(401)
          .json({ success: false, error: "vault_reauth_failed" });
      }

      consumeReauthToken(reauthToken);
      return issueGrantForRequest(request, response, {
        userId,
        method: reauth.method || "reauth_token",
      });
    }
  );

  app.post("/vault/lock", [validatedRequest], async (request, response) => {
    const userId = currentUserId(response);
    const context = currentClientContext(request);
    if (!userId || !context) {
      return response
        .status(401)
        .json({ success: false, error: "unauthorized" });
    }

    const revokedCount = revokeVaultAccessGrants({
      userId,
      clientId: context.clientId,
    });
    const revokedSensitiveCount = revokeSensitiveSessions({
      userId,
      clientId: context.clientId,
      resourceType: "vault",
    });
    void logVaultEvent(
      "vault_locked",
      { revokedGrantCount: revokedCount, revokedSensitiveCount },
      userId
    );
    return response
      .status(200)
      .json({ success: true, revokedCount, revokedSensitiveCount });
  });

  app.get("/vault/items", [validatedRequest], async (request, response) => {
    const userId = currentUserId(response);
    if (!userId) {
      return response
        .status(401)
        .json({ success: false, error: "unauthorized" });
    }

    const items = await DataAccessCenter.vault.listItems({
      userId,
      itemType: request.query?.type || null,
    });
    return response.status(200).json({ success: true, items });
  });

  app.get(
    "/vault/items/:itemId",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      if (!userId) {
        return response
          .status(401)
          .json({ success: false, error: "unauthorized" });
      }

      const grant = await requireVaultGrant(request, response, {
        userId,
        action: "read",
      });
      if (!grant.ok) return grant.response;

      const item = await DataAccessCenter.vault.getItem({
        userId,
        itemId: request.params.itemId,
        includeEncryptedPayload: true,
      });
      if (!item) {
        return response
          .status(404)
          .json({ success: false, error: "vault_item_not_found" });
      }
      void logVaultEvent(
        "vault_item_read",
        {
          itemId: item.itemId,
          itemType: item.itemType,
          cryptoVersion: item.cryptoVersion,
          grantMethod: grant.grant?.method || null,
        },
        userId
      );
      return response.status(200).json({ success: true, item });
    }
  );

  app.post("/vault/items", [validatedRequest], async (request, response) => {
    const userId = currentUserId(response);
    if (!userId) {
      return response
        .status(401)
        .json({ success: false, error: "unauthorized" });
    }

    try {
      const body = reqBody(request);
      const item = await DataAccessCenter.vault.createOrUpdateItem({
        userId,
        itemId: body.itemId || body.id || null,
        itemType: body.itemType || body.type || "secret",
        label: body.label || null,
        encryptedPayload: body.encryptedPayload,
        keyId: body.keyId || null,
        cryptoVersion: body.cryptoVersion || null,
        metadata: body.metadata || {},
      });

      void logVaultEvent(
        "vault_item_saved",
        {
          itemId: item.itemId,
          itemType: item.itemType,
          cryptoVersion: item.cryptoVersion,
        },
        userId
      );
      return response.status(200).json({ success: true, item });
    } catch (error) {
      return vaultErrorResponse(response, error);
    }
  });

  app.delete(
    "/vault/items/:itemId",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      if (!userId) {
        return response
          .status(401)
          .json({ success: false, error: "unauthorized" });
      }

      const grant = await requireVaultGrant(request, response, {
        userId,
        action: "delete",
      });
      if (!grant.ok) return grant.response;

      const deleted = await DataAccessCenter.vault.deleteItem({
        userId,
        itemId: request.params.itemId,
      });
      if (!deleted) {
        return response
          .status(404)
          .json({ success: false, error: "vault_item_not_found" });
      }

      void logVaultEvent(
        "vault_item_deleted",
        { itemId: request.params.itemId },
        userId
      );
      return response.status(200).json({ success: true, deleted: true });
    }
  );
}

module.exports = { vaultEndpoints };
