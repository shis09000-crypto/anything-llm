const {
  EventLogRepository: EventLogs,
} = require("../repositories/eventLogRepository");
const { DataAccessCenter } = require("../utils/dataAccess");
const { reqBody } = require("../utils/http");
const {
  getClientContext,
  getClientRecord,
} = require("../utils/clientIdentity");
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
const {
  canUsePasswordCredential,
  verifyPassword,
} = require("../utils/security/passwordCredential");
const {
  observeDeviceEpochConflict,
  observeVaultKem,
} = require("../utils/security/cryptoObservability");
const crypto = require("crypto");
const {
  USER_ROOT_DERIVATION_SUITE_ID,
  USER_ROOT_ENVELOPE_VERSION,
  USER_ROOT_TRANSPORT_SUITE_ID,
} = require("../utils/security/userKeyDerivation");

const User = DataAccessCenter.user;

function currentUserId(response) {
  const id = Number(response?.locals?.user?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function currentAuthUserId(response) {
  const id = Number(
    response?.locals?.authSession?.authUserId ||
      response?.locals?.user?.authUserId
  );
  return Number.isSafeInteger(id) && id > 0 ? id : null;
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

function validVaultKeyEnvelope(envelope, { source, target, keyEpoch } = {}) {
  const createdAt = Date.parse(envelope?.createdAt);
  const expiresAt = Date.parse(envelope?.expiresAt);
  const now = Date.now();
  return Boolean(
    source &&
      !source.revokedAt &&
      target &&
      !target.revokedAt &&
      ["athena-vault-key-envelope:v1", "athena-vault-key-envelope:v2"].includes(
        envelope?.version
      ) &&
      envelope?.kemSuiteId === "vault-xwing-mldsa65-v1" &&
      (source.vaultSigningSuiteId || source.suiteId) === envelope.kemSuiteId &&
      (target.hybridKemSuiteId || target.suiteId) === envelope.kemSuiteId &&
      envelope.sourceClientId === source.clientId &&
      envelope.targetClientId === target.clientId &&
      envelope.targetKEMPublicKey ===
        (target.hybridKemPublicKey || target.kemPublicKey) &&
      envelope.p256PublicKey ===
        (source.vaultSigningP256PublicKey || source.p256PublicKey) &&
      envelope.mlDSA65PublicKey ===
        (source.vaultSigningMLDSA65PublicKey || source.mlDSA65PublicKey) &&
      Number(envelope.sourceKeyGeneration || 1) ===
        Number(source.keyGeneration || source.vaultKeyGeneration || 1) &&
      Number(envelope.targetKeyGeneration || 1) ===
        Number(target.keyGeneration || target.vaultKeyGeneration || 1) &&
      Number(envelope.keyEpoch) === Number(keyEpoch) &&
      Number.isSafeInteger(Number(keyEpoch)) &&
      Number(keyEpoch) > 0 &&
      /^[A-Za-z0-9_-]{43}$/.test(String(envelope.challengeSHA256 || "")) &&
      Number.isFinite(createdAt) &&
      Number.isFinite(expiresAt) &&
      createdAt <= now + 60_000 &&
      expiresAt > now &&
      expiresAt - createdAt > 0 &&
      expiresAt - createdAt <= 10 * 60_000
  );
}

function validUserRootEnvelope(
  envelope,
  { authUserId, source, target, rootEpoch } = {}
) {
  const createdAt = Date.parse(envelope?.createdAt);
  const expiresAt = Date.parse(envelope?.expiresAt);
  const challenge = String(envelope?.challenge || "");
  const challengeData = /^[A-Za-z0-9_-]{43}$/.test(challenge)
    ? Buffer.from(challenge, "base64url")
    : null;
  const challengeHash = challengeData
    ? crypto
        .createHash("sha256")
        .update(challengeData)
        .digest()
        .toString("base64url")
    : null;
  const now = Date.now();
  return Boolean(
    Number.isSafeInteger(Number(authUserId)) &&
      Number(authUserId) > 0 &&
      source &&
      !source.revokedAt &&
      target &&
      !target.revokedAt &&
      envelope?.version === USER_ROOT_ENVELOPE_VERSION &&
      envelope?.materialType === "user-root-key" &&
      envelope?.derivationSuiteId === USER_ROOT_DERIVATION_SUITE_ID &&
      envelope?.transportSuiteId === USER_ROOT_TRANSPORT_SUITE_ID &&
      Number(envelope.authUserId) === Number(authUserId) &&
      Number(envelope.rootEpoch) === Number(rootEpoch) &&
      Number.isSafeInteger(Number(rootEpoch)) &&
      Number(rootEpoch) > 0 &&
      /^[A-Za-z0-9_-]{43}$/.test(String(envelope.rootKeyId || "")) &&
      /^[A-Za-z0-9._:-]{1,256}$/.test(String(envelope.challengeId || "")) &&
      challengeData?.length === 32 &&
      challengeData.toString("base64url") === challenge &&
      /^[A-Za-z0-9_-]{43}$/.test(String(envelope.challengeSHA256 || "")) &&
      challengeHash === envelope.challengeSHA256 &&
      envelope.sourceClientId === source.clientId &&
      envelope.targetClientId === target.clientId &&
      envelope.targetKEMPublicKey ===
        (target.hybridKemPublicKey || target.kemPublicKey) &&
      envelope.p256PublicKey ===
        (source.vaultSigningP256PublicKey || source.p256PublicKey) &&
      envelope.mlDSA65PublicKey ===
        (source.vaultSigningMLDSA65PublicKey || source.mlDSA65PublicKey) &&
      Number(envelope.sourceKeyGeneration) ===
        Number(source.keyGeneration || source.vaultKeyGeneration || 1) &&
      Number(envelope.targetKeyGeneration) ===
        Number(target.keyGeneration || target.vaultKeyGeneration || 1) &&
      /^[A-Za-z0-9_-]{64,8192}$/.test(String(envelope.encapsulatedKey || "")) &&
      /^[A-Za-z0-9_-]{64,349526}$/.test(String(envelope.sealedRootKey || "")) &&
      /^[A-Za-z0-9_-]{64,512}$/.test(String(envelope.p256Signature || "")) &&
      /^[A-Za-z0-9_-]{128,8192}$/.test(
        String(envelope.mlDSA65Signature || "")
      ) &&
      Number.isFinite(createdAt) &&
      Number.isFinite(expiresAt) &&
      createdAt <= now + 60_000 &&
      expiresAt > now &&
      expiresAt - createdAt > 0 &&
      expiresAt - createdAt <= 10 * 60_000
  );
}

function userRootErrorResponse(response, error) {
  const message = String(error?.message || error || "user_root_error");
  const status = /already|conflict|mismatch|not_initialized/.test(message)
    ? 409
    : /too_large|size/.test(message)
      ? 413
      : 400;
  return response.status(status).json({ success: false, error: message });
}

function validUserRootClient(client) {
  return Boolean(
    client &&
      !client.revokedAt &&
      (client.hybridKemSuiteId || client.suiteId) ===
        "vault-xwing-mldsa65-v1" &&
      (client.hybridKemPublicKey || client.kemPublicKey) &&
      (client.vaultSigningP256PublicKey || client.p256PublicKey) &&
      (client.vaultSigningMLDSA65PublicKey || client.mlDSA65PublicKey) &&
      Number(client.vaultKeyGeneration || client.keyGeneration || 0) > 0
  );
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
          !canUsePasswordCredential(user) ||
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

  app.get(
    "/vault/user-root-key",
    [validatedRequest],
    async (request, response) => {
      const authUserId = currentAuthUserId(response);
      const context = currentClientContext(request);
      if (
        !authUserId ||
        !context ||
        !request.signedRequest?.postQuantumVerified
      )
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_shared_identity_required",
        });
      const status = await DataAccessCenter.vault.userRootStatus({
        authUserId,
        targetClientId: context.clientId,
      });
      return response.status(200).json({ success: true, ...status });
    }
  );

  app.post(
    "/vault/user-root-key/challenge",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      const authUserId = currentAuthUserId(response);
      const context = currentClientContext(request);
      if (
        !userId ||
        !authUserId ||
        !context ||
        !request.signedRequest?.postQuantumVerified
      )
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_shared_identity_required",
        });
      const body = reqBody(request) || {};
      const purpose = String(body.purpose || "").trim();
      const targetClientId = String(
        body.targetClientId || context.clientId
      ).trim();
      try {
        const [source, target] = await Promise.all([
          getClientRecord({
            userId,
            clientId: context.clientId,
            includeRevoked: true,
          }),
          getClientRecord({
            userId,
            clientId: targetClientId,
            includeRevoked: true,
          }),
        ]);
        if (
          !validUserRootClient(source) ||
          !validUserRootClient(target) ||
          (purpose === "initialize" && targetClientId !== context.clientId)
        )
          return response.status(409).json({
            success: false,
            error: "user_root_device_binding_invalid",
          });
        const challenge = await DataAccessCenter.vault.issueUserRootChallenge({
          authUserId,
          sourceClientId: context.clientId,
          targetClientId,
          purpose,
        });
        void logVaultEvent(
          "user_root_challenge_issued",
          { purpose, targetClientId },
          userId
        );
        return response.status(201).json({ success: true, ...challenge });
      } catch (error) {
        return userRootErrorResponse(response, error);
      }
    }
  );

  app.post(
    "/vault/user-root-key/initialize",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      const authUserId = currentAuthUserId(response);
      const context = currentClientContext(request);
      if (
        !userId ||
        !authUserId ||
        !context ||
        !request.signedRequest?.postQuantumVerified
      )
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_shared_identity_required",
        });
      const grant = await requireVaultGrant(request, response, {
        userId,
        action: "initialize-user-root-key",
      });
      if (!grant.ok) return grant.response;
      const body = reqBody(request) || {};
      const envelope = body.envelope;
      try {
        const source = await getClientRecord({
          userId,
          clientId: context.clientId,
          includeRevoked: true,
        });
        if (
          !validUserRootClient(source) ||
          !validUserRootEnvelope(envelope, {
            authUserId,
            source,
            target: source,
            rootEpoch: body.rootEpoch,
          })
        )
          return response.status(409).json({
            success: false,
            error: "user_root_device_binding_invalid",
          });
        const result = await DataAccessCenter.vault.initializeUserRoot({
          authUserId,
          sourceClientId: context.clientId,
          targetClientId: context.clientId,
          sourceKeyGeneration: envelope.sourceKeyGeneration,
          targetKeyGeneration: envelope.targetKeyGeneration,
          rootEpoch: body.rootEpoch,
          challengeId: body.challengeId,
          envelope,
        });
        void logVaultEvent(
          "user_root_initialized",
          {
            rootEpoch: result.epoch.rootEpoch,
            clientId: context.clientId,
            derivationSuiteId: result.epoch.derivationSuiteId,
            transportSuiteId: result.epoch.transportSuiteId,
          },
          userId
        );
        return response.status(result.initialized ? 201 : 200).json({
          success: true,
          initialized: result.initialized,
          rootEpoch: result.epoch.rootEpoch,
          rootKeyId: result.epoch.rootKeyId,
        });
      } catch (error) {
        return userRootErrorResponse(response, error);
      }
    }
  );

  app.post(
    "/vault/user-root-key/envelopes",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      const authUserId = currentAuthUserId(response);
      const context = currentClientContext(request);
      if (
        !userId ||
        !authUserId ||
        !context ||
        !request.signedRequest?.postQuantumVerified
      )
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_shared_identity_required",
        });
      const grant = await requireVaultGrant(request, response, {
        userId,
        action: "authorize-user-root-key",
      });
      if (!grant.ok) return grant.response;
      const body = reqBody(request) || {};
      const targetClientId = String(body.targetClientId || "").trim();
      const envelope = body.envelope;
      try {
        const sourceGeneration = Number(envelope?.sourceKeyGeneration);
        const targetGeneration = Number(envelope?.targetKeyGeneration);
        const [
          currentSource,
          currentTarget,
          historicalSource,
          historicalTarget,
        ] = await Promise.all([
          getClientRecord({
            userId,
            clientId: context.clientId,
            includeRevoked: true,
          }),
          getClientRecord({
            userId,
            clientId: targetClientId,
            includeRevoked: true,
          }),
          DataAccessCenter.vault.getDeviceKeyRegistration({
            userId,
            clientId: context.clientId,
            keyGeneration: sourceGeneration,
          }),
          DataAccessCenter.vault.getDeviceKeyRegistration({
            userId,
            clientId: targetClientId,
            keyGeneration: targetGeneration,
          }),
        ]);
        const source = historicalSource || currentSource;
        const target = historicalTarget || currentTarget;
        if (
          !validUserRootClient(currentSource) ||
          !validUserRootClient(currentTarget) ||
          !validUserRootEnvelope(envelope, {
            authUserId,
            source,
            target,
            rootEpoch: body.rootEpoch,
          })
        )
          return response.status(409).json({
            success: false,
            error: "user_root_device_binding_invalid",
          });
        const stored = await DataAccessCenter.vault.storeUserRootEnvelope({
          authUserId,
          sourceClientId: context.clientId,
          targetClientId,
          sourceKeyGeneration: sourceGeneration,
          targetKeyGeneration: targetGeneration,
          rootEpoch: body.rootEpoch,
          challengeId: body.challengeId,
          envelope,
        });
        void logVaultEvent(
          "user_root_envelope_created",
          {
            envelopeId: stored.id,
            targetClientId,
            rootEpoch: stored.rootEpoch,
          },
          userId
        );
        return response.status(201).json({
          success: true,
          envelopeId: stored.id,
          rootEpoch: stored.rootEpoch,
        });
      } catch (error) {
        return userRootErrorResponse(response, error);
      }
    }
  );

  app.get(
    "/vault/user-root-key/authorization-targets",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      const authUserId = currentAuthUserId(response);
      const context = currentClientContext(request);
      if (
        !userId ||
        !authUserId ||
        !context ||
        !request.signedRequest?.postQuantumVerified
      )
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_shared_identity_required",
        });
      try {
        const targets =
          await DataAccessCenter.vault.listUserRootAuthorizationTargets({
            userId,
            authUserId,
            sourceClientId: context.clientId,
          });
        return response.status(200).json({
          success: true,
          targets: targets.map((target) => ({
            clientId: target.clientId,
            keyGeneration: target.keyGeneration,
            kemSuiteId: target.suiteId,
            kemPublicKey: target.kemPublicKey,
            p256PublicKey: target.p256PublicKey,
            mlDSA65PublicKey: target.mlDSA65PublicKey,
          })),
        });
      } catch (error) {
        return userRootErrorResponse(response, error);
      }
    }
  );

  app.get(
    "/vault/user-root-key/envelopes",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      const authUserId = currentAuthUserId(response);
      const context = currentClientContext(request);
      if (
        !userId ||
        !authUserId ||
        !context ||
        !request.signedRequest?.postQuantumVerified
      )
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_shared_identity_required",
        });
      const pending = await DataAccessCenter.vault.pendingUserRootEnvelopes({
        authUserId,
        targetClientId: context.clientId,
      });
      const envelopes = (
        await Promise.all(
          pending.map(async (entry) => {
            const source =
              (await DataAccessCenter.vault.getDeviceKeyRegistration({
                userId,
                clientId: entry.sourceClientId,
                keyGeneration: entry.sourceKeyGeneration,
              })) ||
              (await getClientRecord({
                userId,
                clientId: entry.sourceClientId,
                includeRevoked: true,
              }));
            if (!source) return null;
            return {
              ...entry,
              trustedSource: {
                clientId: source.clientId,
                suiteId:
                  source.vaultSigningSuiteId ||
                  source.suiteId ||
                  "vault-xwing-mldsa65-v1",
                keyGeneration:
                  source.keyGeneration || source.vaultKeyGeneration || 1,
                p256PublicKey:
                  source.vaultSigningP256PublicKey || source.p256PublicKey,
                mlDSA65PublicKey:
                  source.vaultSigningMLDSA65PublicKey ||
                  source.mlDSA65PublicKey,
              },
            };
          })
        )
      ).filter(Boolean);
      return response.status(200).json({ success: true, envelopes });
    }
  );

  app.post(
    "/vault/user-root-key/envelopes/:envelopeId/consume",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      const authUserId = currentAuthUserId(response);
      const context = currentClientContext(request);
      if (
        !userId ||
        !authUserId ||
        !context ||
        !request.signedRequest?.postQuantumVerified
      )
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_shared_identity_required",
        });
      const client = await getClientRecord({
        userId,
        clientId: context.clientId,
        includeRevoked: true,
      });
      if (!validUserRootClient(client))
        return response.status(409).json({
          success: false,
          error: "user_root_device_binding_invalid",
        });
      const consumed = await DataAccessCenter.vault.consumeUserRootEnvelope({
        authUserId,
        targetClientId: context.clientId,
        targetKeyGeneration: client.vaultKeyGeneration || client.keyGeneration,
        envelopeId: request.params.envelopeId,
      });
      if (!consumed)
        return response.status(404).json({
          success: false,
          error: "user_root_envelope_not_found",
        });
      void logVaultEvent(
        "user_root_envelope_consumed",
        { envelopeId: request.params.envelopeId },
        userId
      );
      return response.status(200).json({ success: true, consumed: true });
    }
  );

  app.get(
    "/vault/user-domain-wraps",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      const authUserId = currentAuthUserId(response);
      const context = currentClientContext(request);
      if (
        !userId ||
        !authUserId ||
        !context ||
        !request.signedRequest?.postQuantumVerified
      )
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_shared_identity_required",
        });
      try {
        const wraps = await DataAccessCenter.vault.listUserDomainWraps({
          userId,
          authUserId,
          status: request.query?.status || null,
          resourceType: request.query?.resourceType || null,
          resourceId: request.query?.resourceId || null,
          limit: request.query?.limit || 50,
          includeEnvelope: request.query?.includeEnvelope === "true",
        });
        return response.status(200).json({ success: true, wraps });
      } catch (error) {
        return userRootErrorResponse(response, error);
      }
    }
  );

  app.post(
    "/vault/user-domain-wraps/:wrapId/prepare",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      const authUserId = currentAuthUserId(response);
      const context = currentClientContext(request);
      if (
        !userId ||
        !authUserId ||
        !context ||
        !request.signedRequest?.postQuantumVerified
      )
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_shared_identity_required",
        });
      const grant = await requireVaultGrant(request, response, {
        userId,
        action: "prepare-user-domain-wrap",
      });
      if (!grant.ok) return grant.response;
      try {
        const client = await getClientRecord({
          userId,
          clientId: context.clientId,
          includeRevoked: true,
        });
        if (!validUserRootClient(client))
          throw new Error("user_domain_device_binding_invalid");
        const envelope = await DataAccessCenter.vault.prepareUserDomainWrap({
          wrapId: request.params.wrapId,
          userId,
          authUserId,
          targetClientId: context.clientId,
          targetKeyGeneration:
            client.vaultKeyGeneration || client.keyGeneration || 1,
          targetKEMPublicKey: client.hybridKemPublicKey || client.kemPublicKey,
        });
        void logVaultEvent(
          "user_domain_wrap_material_prepared",
          {
            wrapId: request.params.wrapId,
            resourceType: envelope.resourceType,
            domain: envelope.domain,
          },
          userId
        );
        return response.status(200).json({ success: true, envelope });
      } catch (error) {
        return userRootErrorResponse(response, error);
      }
    }
  );

  app.put(
    "/vault/user-domain-wraps/:wrapId",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      const authUserId = currentAuthUserId(response);
      const context = currentClientContext(request);
      if (
        !userId ||
        !authUserId ||
        !context ||
        !request.signedRequest?.postQuantumVerified
      )
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_shared_identity_required",
        });
      try {
        const wrap = await DataAccessCenter.vault.completeUserDomainWrap({
          wrapId: request.params.wrapId,
          userId,
          authUserId,
          clientId: context.clientId,
          envelope: reqBody(request)?.envelope,
        });
        void logVaultEvent(
          "user_domain_wrap_completed",
          {
            wrapId: wrap.id,
            resourceType: wrap.resourceType,
            domain: wrap.domain,
            wrapVersion: wrap.wrapVersion,
            rootKeyId: wrap.rootKeyId,
            domainKeyVersion: wrap.domainKeyVersion,
          },
          userId
        );
        return response.status(200).json({ success: true, wrap });
      } catch (error) {
        return userRootErrorResponse(response, error);
      }
    }
  );

  app.get(
    "/vault/user-domain-wraps/coverage",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      const authUserId = currentAuthUserId(response);
      const context = currentClientContext(request);
      if (
        !userId ||
        !authUserId ||
        !context ||
        !request.signedRequest?.postQuantumVerified
      )
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_shared_identity_required",
        });
      const coverage = await DataAccessCenter.vault.userDomainWrapCoverage({
        userId,
        authUserId,
      });
      return response.status(200).json({ success: true, coverage });
    }
  );

  app.post(
    "/vault/device-key-envelopes",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      const context = currentClientContext(request);
      if (!userId || !context || !request.signedRequest?.postQuantumVerified)
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_client_identity_required",
        });
      const body = reqBody(request) || {};
      const targetClientId = String(body.targetClientId || "").trim();
      const envelope = body.envelope;
      const [sourceClient, targetClient] = await Promise.all([
        getClientRecord({
          userId,
          clientId: context.clientId,
          includeRevoked: true,
        }),
        getClientRecord({
          userId,
          clientId: targetClientId,
          includeRevoked: true,
        }),
      ]);
      const sourceKeyGeneration = Number(envelope?.sourceKeyGeneration || 1);
      const targetKeyGeneration = Number(envelope?.targetKeyGeneration || 1);
      const [historicalSource, historicalTarget] = await Promise.all([
        DataAccessCenter.vault.getDeviceKeyRegistration({
          userId,
          clientId: context.clientId,
          keyGeneration: sourceKeyGeneration,
        }),
        DataAccessCenter.vault.getDeviceKeyRegistration({
          userId,
          clientId: targetClientId,
          keyGeneration: targetKeyGeneration,
        }),
      ]);
      const source = historicalSource || sourceClient;
      const target = historicalTarget || targetClient;
      if (
        !sourceClient ||
        sourceClient.revokedAt ||
        !targetClient ||
        targetClient.revokedAt ||
        !validVaultKeyEnvelope(envelope, {
          source,
          target,
          keyEpoch: body.keyEpoch,
        })
      ) {
        observeVaultKem("store_envelope", "invalid_envelope");
        return response
          .status(409)
          .json({ success: false, error: "vault_device_key_binding_invalid" });
      }
      let stored;
      try {
        stored = await DataAccessCenter.vault.storeDeviceKeyEnvelope({
          userId,
          sourceClientId: context.clientId,
          targetClientId,
          sourceKeyGeneration,
          targetKeyGeneration,
          keyEpoch: body.keyEpoch,
          envelope,
        });
      } catch (error) {
        if (
          ["vault_key_epoch_conflict", "vault_key_epoch_stale"].includes(
            error?.message
          )
        ) {
          observeDeviceEpochConflict(
            error.message === "vault_key_epoch_stale" ? "stale" : "conflict"
          );
          observeVaultKem("store_envelope", "rejected");
          return response
            .status(409)
            .json({ success: false, error: error.message });
        }
        throw error;
      }
      observeVaultKem("store_envelope", "success");
      void logVaultEvent(
        "vault_device_key_envelope_created",
        {
          envelopeId: stored.id,
          targetClientId,
          keyEpoch: stored.keyEpoch,
          suiteId: envelope.kemSuiteId,
        },
        userId
      );
      return response.status(201).json({
        success: true,
        envelopeId: stored.id,
        keyEpoch: stored.keyEpoch,
      });
    }
  );

  app.get(
    "/vault/device-key-envelopes",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      const context = currentClientContext(request);
      if (!userId || !context || !request.signedRequest?.postQuantumVerified)
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_client_identity_required",
        });
      const pending = await DataAccessCenter.vault.pendingDeviceKeyEnvelopes({
        userId,
        targetClientId: context.clientId,
      });
      const envelopes = (
        await Promise.all(
          pending.map(async (entry) => {
            const source = await getClientRecord({
              userId,
              clientId: entry.sourceClientId,
              includeRevoked: true,
            });
            const historicalSource =
              await DataAccessCenter.vault.getDeviceKeyRegistration({
                userId,
                clientId: entry.sourceClientId,
                keyGeneration: entry.sourceKeyGeneration || 1,
              });
            const trusted = historicalSource || source;
            if (
              !trusted ||
              !(trusted.vaultSigningP256PublicKey || trusted.p256PublicKey) ||
              !(
                trusted.vaultSigningMLDSA65PublicKey || trusted.mlDSA65PublicKey
              ) ||
              !(trusted.vaultSigningSuiteId || trusted.suiteId)
            )
              return null;
            return {
              ...entry,
              trustedSource: {
                clientId: trusted.clientId,
                suiteId: trusted.vaultSigningSuiteId || trusted.suiteId,
                keyGeneration:
                  trusted.keyGeneration ||
                  trusted.vaultKeyGeneration ||
                  entry.sourceKeyGeneration ||
                  1,
                p256PublicKey:
                  trusted.vaultSigningP256PublicKey || trusted.p256PublicKey,
                mlDSA65PublicKey:
                  trusted.vaultSigningMLDSA65PublicKey ||
                  trusted.mlDSA65PublicKey,
              },
            };
          })
        )
      ).filter(Boolean);
      return response.status(200).json({ success: true, envelopes });
    }
  );

  app.get(
    "/vault/key-epochs",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      const context = currentClientContext(request);
      if (!userId || !context || !request.signedRequest?.postQuantumVerified)
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_client_identity_required",
        });
      const epochs = await DataAccessCenter.vault.listKeyEpochs({ userId });
      return response.status(200).json({ success: true, epochs });
    }
  );

  app.post(
    "/vault/key-epochs/rotate",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      const context = currentClientContext(request);
      if (!userId || !context || !request.signedRequest?.postQuantumVerified)
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_client_identity_required",
        });
      const grant = await requireVaultGrant(request, response, {
        userId,
        action: "rotate-key-epoch",
      });
      if (!grant.ok) return grant.response;
      try {
        const epoch = await DataAccessCenter.vault.beginKeyEpochRotation({
          userId,
          clientId: context.clientId,
        });
        void logVaultEvent(
          "vault_key_epoch_rotation_started",
          { keyEpoch: epoch.keyEpoch, clientId: context.clientId },
          userId
        );
        return response.status(201).json({ success: true, epoch });
      } catch (error) {
        if (String(error?.message).includes("rate_limited"))
          return response
            .status(429)
            .json({ success: false, error: error.message });
        throw error;
      }
    }
  );

  app.post(
    "/vault/key-epochs/:keyEpoch/ack",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      const context = currentClientContext(request);
      if (!userId || !context || !request.signedRequest?.postQuantumVerified)
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_client_identity_required",
        });
      const client = await getClientRecord({
        userId,
        clientId: context.clientId,
        includeRevoked: true,
      });
      if (!client || client.revokedAt || Number(client.vaultKeyGeneration) < 1)
        return response.status(409).json({
          success: false,
          error: "vault_device_key_generation_untrusted",
        });
      const body = reqBody(request) || {};
      const result = await DataAccessCenter.vault.acknowledgeKeyEpoch({
        userId,
        clientId: context.clientId,
        keyEpoch: request.params.keyEpoch,
        keyGeneration: client.vaultKeyGeneration,
        inventoryHash: body.inventoryHash || null,
      });
      return response.status(200).json({ success: true, ...result });
    }
  );

  app.post(
    "/vault/key-epochs/:keyEpoch/retire",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      if (!userId || !request.signedRequest?.postQuantumVerified)
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_client_identity_required",
        });
      const grant = await requireVaultGrant(request, response, {
        userId,
        action: "retire-key-epoch",
      });
      if (!grant.ok) return grant.response;
      const epoch = await DataAccessCenter.vault.retireKeyEpoch({
        userId,
        keyEpoch: request.params.keyEpoch,
      });
      void logVaultEvent(
        "vault_key_epoch_retired",
        { keyEpoch: epoch.keyEpoch },
        userId
      );
      return response.status(200).json({ success: true, epoch });
    }
  );

  app.post(
    "/vault/key-epochs/:keyEpoch/cancel",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      if (!userId || !request.signedRequest?.postQuantumVerified)
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_client_identity_required",
        });
      const grant = await requireVaultGrant(request, response, {
        userId,
        action: "cancel-key-epoch",
      });
      if (!grant.ok) return grant.response;
      const epoch = await DataAccessCenter.vault.cancelKeyEpochRotation({
        userId,
        keyEpoch: request.params.keyEpoch,
      });
      void logVaultEvent(
        "vault_key_epoch_rotation_cancelled",
        { keyEpoch: epoch.keyEpoch },
        userId
      );
      return response.status(200).json({ success: true, epoch });
    }
  );

  app.post(
    "/vault/recovery-packages",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      const context = currentClientContext(request);
      if (!userId || !context || !request.signedRequest?.postQuantumVerified)
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_client_identity_required",
        });
      const grant = await requireVaultGrant(request, response, {
        userId,
        action: "create-recovery-package",
      });
      if (!grant.ok) return grant.response;
      const body = reqBody(request) || {};
      const recoveryPackage = await DataAccessCenter.vault.storeRecoveryPackage(
        {
          userId,
          clientId: context.clientId,
          recoveryKeyId: body.recoveryKeyId,
          keyEpoch: body.keyEpoch,
          suiteId: body.suiteId,
          encryptedPackage: body.encryptedPackage,
        }
      );
      void logVaultEvent(
        "vault_recovery_package_created",
        {
          recoveryKeyId: recoveryPackage.recoveryKeyId,
          keyEpoch: recoveryPackage.keyEpoch,
        },
        userId
      );
      return response.status(201).json({
        success: true,
        recoveryKeyId: recoveryPackage.recoveryKeyId,
        keyEpoch: recoveryPackage.keyEpoch,
      });
    }
  );

  app.get(
    "/vault/recovery-packages/:recoveryKeyId",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      if (!userId || !request.signedRequest?.postQuantumVerified)
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_client_identity_required",
        });
      const grant = await requireVaultGrant(request, response, {
        userId,
        action: "recover-vault",
      });
      if (!grant.ok) return grant.response;
      const recoveryPackage = await DataAccessCenter.vault.getRecoveryPackage({
        userId,
        recoveryKeyId: request.params.recoveryKeyId,
      });
      if (!recoveryPackage)
        return response
          .status(404)
          .json({ success: false, error: "vault_recovery_package_not_found" });
      void logVaultEvent(
        "vault_recovery_package_accessed",
        {
          recoveryKeyId: recoveryPackage.recoveryKeyId,
          keyEpoch: recoveryPackage.keyEpoch,
        },
        userId
      );
      return response.status(200).json({
        success: true,
        recoveryPackage,
      });
    }
  );

  app.delete(
    "/vault/recovery-packages/:recoveryKeyId",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      if (!userId || !request.signedRequest?.postQuantumVerified)
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_client_identity_required",
        });
      const grant = await requireVaultGrant(request, response, {
        userId,
        action: "revoke-recovery-package",
      });
      if (!grant.ok) return grant.response;
      const result = await DataAccessCenter.vault.revokeRecoveryPackage({
        userId,
        recoveryKeyId: request.params.recoveryKeyId,
      });
      return response
        .status(result.count ? 200 : 404)
        .json({ success: result.count > 0, revoked: result.count > 0 });
    }
  );

  app.post(
    "/vault/device-key-envelopes/:envelopeId/consume",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      const context = currentClientContext(request);
      if (!userId || !context || !request.signedRequest?.postQuantumVerified)
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_client_identity_required",
        });
      const consumed = await DataAccessCenter.vault.consumeDeviceKeyEnvelope({
        userId,
        targetClientId: context.clientId,
        envelopeId: request.params.envelopeId,
      });
      if (!consumed)
        return response
          .status(404)
          .json({ success: false, error: "vault_key_envelope_not_found" });
      void logVaultEvent(
        "vault_device_key_envelope_consumed",
        { envelopeId: request.params.envelopeId },
        userId
      );
      return response.status(200).json({ success: true, consumed: true });
    }
  );

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
    const authUserId = currentAuthUserId(response);
    const context = currentClientContext(request);
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
      let userDomainWrap = null;
      if (authUserId && item.keyId) {
        const queued = await DataAccessCenter.vault.queueUserDomainWrap({
          userId,
          authUserId,
          resourceType: "vault-master-key",
          resourceId: item.keyId,
          domain: "vault",
          platformWrapVersion: `vault-client:${item.cryptoVersion}`,
          platformKeyId: item.keyId,
          createdByClientId: context?.clientId || null,
        });
        userDomainWrap = queued.wrap || null;
        if (body.userDomainWrap) {
          if (
            !context ||
            !request.signedRequest?.postQuantumVerified ||
            !queued.wrap
          )
            throw new Error("hybrid_signed_shared_identity_required");
          userDomainWrap = await DataAccessCenter.vault.completeUserDomainWrap({
            wrapId: queued.wrap.id,
            userId,
            authUserId,
            clientId: context.clientId,
            envelope: body.userDomainWrap,
          });
        }
      }

      void logVaultEvent(
        "vault_item_saved",
        {
          itemId: item.itemId,
          itemType: item.itemType,
          cryptoVersion: item.cryptoVersion,
          userDomainWrapStatus: userDomainWrap?.status || null,
        },
        userId
      );
      return response.status(200).json({ success: true, item, userDomainWrap });
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

module.exports = {
  validUserRootEnvelope,
  validVaultKeyEnvelope,
  vaultEndpoints,
};
