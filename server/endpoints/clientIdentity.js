const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { reqBody } = require("../utils/http");
const {
  getClientContext,
  listUserClients,
  recordClientTrustCheckpoint,
  revokeAllOtherClients,
  revokeClient,
  commitClientDeviceKeyRotation,
  prepareClientDeviceKeyRotation,
} = require("../utils/clientIdentity");
const {
  CLIENT_REVOKED_ERROR,
  SIGNATURE_VERSION,
  ensureClientSigningSecret,
  rotateAllSigningSecrets,
  rotateSigningSecret,
  canonicalPublicKey,
  normalizeDeviceKeyAlgorithm,
  registerClientHybridKEMKey,
} = require("../utils/requestSigning");
const { publishBroadcastEvent } = require("../utils/broadcast");
const {
  completeDeviceAttestation,
  issueDeviceAttestationChallenge,
} = require("../utils/security/deviceAttestation");
const { metrics } = require("../utils/observability/metrics");
const { observeVaultKem } = require("../utils/security/cryptoObservability");

const VAULT_KEM_OBSERVATION_OUTCOMES = new Set([
  "success",
  "invalid_envelope",
  "decapsulation_failed",
  "aead_failed",
  "epoch_mismatch",
]);

function clientIdentityEndpoints(app) {
  if (!app) return;

  app.get(
    "/client-identity/clients",
    [validatedRequest],
    async (request, response) => {
      const context = getClientContext(request);
      if (!context?.userId || context.legacy) {
        return response
          .status(401)
          .json({ success: false, error: "client_identity_required" });
      }

      const clients = await listUserClients({
        userId: context.userId,
        currentClientId: context.clientId,
      });
      return response.status(200).json({ success: true, clients });
    }
  );

  app.post(
    "/client-identity/signing-secret",
    [validatedRequest],
    async (request, response) => {
      const context = getClientContext(request);
      if (!context?.userId || context.legacy) {
        return response
          .status(401)
          .json({ success: false, error: "client_identity_required" });
      }

      const secret = await ensureClientSigningSecret({ context });
      if (secret?.revoked) {
        return response
          .status(403)
          .json({ success: false, error: CLIENT_REVOKED_ERROR });
      }
      if (!secret?.secret) {
        return response
          .status(500)
          .json({ success: false, error: "signing_secret_unavailable" });
      }

      return response.status(200).json({
        success: true,
        signingSecret: secret.secret,
        signatureVersion: secret.signatureVersion || SIGNATURE_VERSION,
        signingSecretVersion: secret.signingSecretVersion || null,
        issuedAt: secret.issuedAt || null,
        rotatedAt: secret.rotatedAt || null,
      });
    }
  );

  app.post(
    "/client-identity/vault-kem-key",
    [validatedRequest],
    async (request, response) => {
      const context = getClientContext(request);
      if (
        !context?.userId ||
        context.legacy ||
        !request.signedRequest?.ok ||
        !request.signedRequest?.postQuantumVerified
      ) {
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_client_identity_required",
        });
      }
      const body = reqBody(request);
      const result = await registerClientHybridKEMKey({
        userId: context.userId,
        clientId: context.clientId,
        kemPublicKey: body.kemPublicKey || body.publicKey,
        p256PublicKey: body.p256PublicKey,
        mlDSA65PublicKey: body.mlDSA65PublicKey,
        suiteId: body.suiteId,
        keyGeneration: body.keyGeneration || 1,
      });
      if (!result.ok) {
        observeVaultKem("register", "rejected");
        return response
          .status(409)
          .json({ success: false, error: result.reasonCode });
      }
      observeVaultKem("register", "success");
      await recordClientTrustCheckpoint(request, {
        action: "client_vault_hybrid_kem_registered",
        resourceType: "athena_client",
        resourceId: context.clientId,
        outcome: "registered",
        metadata: { suiteId: result.suiteId },
      });
      return response.status(200).json({
        success: true,
        suiteId: result.suiteId,
        keyGeneration: result.keyGeneration,
      });
    }
  );

  app.post(
    "/client-identity/vault-kem-key/rotate",
    [validatedRequest],
    async (request, response) => {
      const context = getClientContext(request);
      if (
        !context?.userId ||
        context.legacy ||
        !request.signedRequest?.ok ||
        !request.signedRequest?.postQuantumVerified
      ) {
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_client_identity_required",
        });
      }
      const body = reqBody(request);
      const result = await registerClientHybridKEMKey({
        userId: context.userId,
        clientId: context.clientId,
        kemPublicKey: body.kemPublicKey || body.publicKey,
        p256PublicKey: body.p256PublicKey,
        mlDSA65PublicKey: body.mlDSA65PublicKey,
        suiteId: body.suiteId,
        keyGeneration: body.keyGeneration,
        allowRotation: true,
      });
      if (!result.ok) {
        observeVaultKem("register", "rejected");
        return response
          .status(409)
          .json({ success: false, error: result.reasonCode });
      }
      observeVaultKem("register", "success");
      await recordClientTrustCheckpoint(request, {
        action: "client_vault_hybrid_kem_rotated",
        resourceType: "athena_client",
        resourceId: context.clientId,
        outcome: "rotated",
        metadata: {
          suiteId: result.suiteId,
          keyGeneration: result.keyGeneration,
        },
      });
      return response.status(200).json({
        success: true,
        suiteId: result.suiteId,
        keyGeneration: result.keyGeneration,
        rotated: true,
      });
    }
  );

  app.post(
    "/client-identity/crypto-observations",
    [validatedRequest],
    async (request, response) => {
      const context = getClientContext(request);
      if (
        !context?.userId ||
        context.legacy ||
        !request.signedRequest?.ok ||
        !request.signedRequest?.postQuantumVerified
      ) {
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_client_identity_required",
        });
      }
      const body = reqBody(request) || {};
      if (
        body.category !== "vault_kem" ||
        body.operation !== "unseal" ||
        body.suiteId !== "vault-xwing-mldsa65-v1" ||
        !VAULT_KEM_OBSERVATION_OUTCOMES.has(body.outcome)
      ) {
        return response.status(400).json({
          success: false,
          error: "crypto_observation_invalid",
        });
      }
      observeVaultKem("unseal", body.outcome);
      return response.status(200).json({ success: true });
    }
  );

  app.post(
    "/client-identity/attestation/challenge",
    [validatedRequest],
    async (request, response) => {
      const context = getClientContext(request);
      if (
        !context?.userId ||
        context.legacy ||
        !["ios", "ipad"].includes(String(context.platform).toLowerCase()) ||
        !request.signedRequest?.postQuantumVerified
      )
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_ios_client_required",
        });
      try {
        const challenge = await issueDeviceAttestationChallenge({
          userId: context.userId,
          clientId: context.clientId,
        });
        metrics.deviceAttestationOperations.inc({
          operation: "challenge",
          outcome: "issued",
          provider: challenge.provider,
        });
        await recordClientTrustCheckpoint(request, {
          action: "device_attestation_challenge_issued",
          resourceType: "athena_client",
          resourceId: context.clientId,
          outcome: "issued",
          metadata: { provider: challenge.provider },
        });
        return response.status(201).json({ success: true, ...challenge });
      } catch (error) {
        metrics.deviceAttestationOperations.inc({
          operation: "challenge",
          outcome: "rejected",
          provider: "apple-app-attest",
        });
        return response.status(409).json({
          success: false,
          error: error?.message || "device_attestation_challenge_failed",
        });
      }
    }
  );

  app.post(
    "/client-identity/attestation/verify",
    [validatedRequest],
    async (request, response) => {
      const context = getClientContext(request);
      if (
        !context?.userId ||
        context.legacy ||
        !["ios", "ipad"].includes(String(context.platform).toLowerCase()) ||
        !request.signedRequest?.postQuantumVerified
      )
        return response.status(401).json({
          success: false,
          error: "hybrid_signed_ios_client_required",
        });
      try {
        const body = reqBody(request) || {};
        const result = await completeDeviceAttestation({
          userId: context.userId,
          clientId: context.clientId,
          challengeId: body.challengeId,
          keyId: body.keyId,
          attestationObject: body.attestationObject,
          assertionObject: body.assertionObject,
          appId: body.appId,
        });
        metrics.deviceAttestationOperations.inc({
          operation: "verify",
          outcome: "verified",
          provider: result.provider,
        });
        await recordClientTrustCheckpoint(request, {
          action: "device_attestation_verified",
          resourceType: "athena_client",
          resourceId: context.clientId,
          outcome: "verified",
          metadata: { provider: result.provider },
        });
        publishBroadcastEvent({
          namespace: "client",
          type: "deviceAttestationVerified",
          eventPriority: "critical",
          visibility: "client",
          scope: { userId: context.userId, clientId: context.clientId },
          sourceClientId: context.clientId,
          payload: { clientId: context.clientId },
        });
        return response.status(200).json({ success: true, ...result });
      } catch (error) {
        metrics.deviceAttestationOperations.inc({
          operation: "verify",
          outcome: "rejected",
          provider: "apple-app-attest",
        });
        await recordClientTrustCheckpoint(request, {
          action: "device_attestation_failed",
          resourceType: "athena_client",
          resourceId: context.clientId,
          outcome: "rejected",
          metadata: { reason: error?.message || "unknown" },
        });
        return response.status(409).json({
          success: false,
          error: error?.message || "device_attestation_verification_failed",
        });
      }
    }
  );

  app.post(
    "/client-identity/device-key-rotation/prepare",
    [validatedRequest],
    async (request, response) => {
      const context = getClientContext(request);
      if (!context?.userId || context.legacy) {
        return response
          .status(401)
          .json({ success: false, error: "client_identity_required" });
      }
      const body = reqBody(request);
      const publicKey = canonicalPublicKey(body.publicKey);
      const deviceKeyAlgorithm = normalizeDeviceKeyAlgorithm(
        body.deviceKeyAlgorithm
      );
      if (!publicKey || !deviceKeyAlgorithm) {
        return response.status(400).json({
          success: false,
          error: "invalid_device_public_key",
        });
      }
      const result = await prepareClientDeviceKeyRotation({
        userId: context.userId,
        clientId: context.clientId,
        publicKey,
        deviceKeyAlgorithm,
      });
      if (!result) {
        return response
          .status(404)
          .json({ success: false, error: "client_not_found" });
      }
      await recordClientTrustCheckpoint(request, {
        action: "client_device_key_rotation_prepared",
        resourceType: "athena_client",
        resourceId: context.clientId,
        outcome: result.prepared ? "prepared" : "already_current",
        metadata: {
          result: result.prepared ? "prepared" : "already_current",
          deviceKeyAlgorithm,
        },
      });
      return response.status(200).json({
        success: true,
        rotated: false,
        prepared: result.prepared,
        deviceKeyAlgorithm,
      });
    }
  );

  app.post(
    "/client-identity/device-key-rotation/commit",
    [validatedRequest],
    async (request, response) => {
      const context = getClientContext(request);
      if (!context?.userId || context.legacy) {
        return response
          .status(401)
          .json({ success: false, error: "client_identity_required" });
      }
      const body = reqBody(request);
      const publicKey = canonicalPublicKey(body.publicKey);
      const deviceKeyAlgorithm = normalizeDeviceKeyAlgorithm(
        body.deviceKeyAlgorithm
      );
      if (!publicKey || !deviceKeyAlgorithm) {
        return response.status(400).json({
          success: false,
          error: "invalid_device_public_key",
        });
      }
      const result = await commitClientDeviceKeyRotation({
        userId: context.userId,
        clientId: context.clientId,
        publicKey,
        deviceKeyAlgorithm,
      });
      if (!result) {
        return response
          .status(404)
          .json({ success: false, error: "client_not_found" });
      }
      if (result.pendingMismatch) {
        return response.status(409).json({
          success: false,
          error: "device_key_rotation_not_prepared",
        });
      }
      await recordClientTrustCheckpoint(request, {
        action: "client_device_key_rotated",
        resourceType: "athena_client",
        resourceId: context.clientId,
        outcome: result.rotated ? "rotated" : "already_current",
        metadata: {
          result: result.rotated ? "rotated" : "already_current",
          deviceKeyAlgorithm,
        },
      });
      publishBroadcastEvent({
        namespace: "client",
        type: "deviceKeyRotated",
        eventPriority: "critical",
        visibility: "client",
        scope: { userId: context.userId, clientId: context.clientId },
        sourceClientId: context.clientId,
        payload: { clientId: context.clientId, deviceKeyAlgorithm },
      });
      return response.status(200).json({
        success: true,
        rotated: result.rotated,
        deviceKeyAlgorithm,
      });
    }
  );

  app.post(
    "/client-identity/revoke",
    [validatedRequest],
    async (request, response) => {
      const context = getClientContext(request);
      if (!context?.userId || context.legacy) {
        return response
          .status(401)
          .json({ success: false, error: "client_identity_required" });
      }

      const { clientId } = reqBody(request);
      if (!clientId) {
        return response
          .status(400)
          .json({ success: false, error: "client_id_required" });
      }

      const result = await revokeClient({
        userId: context.userId,
        clientId,
        actorClientId: context.clientId,
      });
      if (!result) {
        return response
          .status(404)
          .json({ success: false, error: "client_not_found" });
      }

      void recordClientTrustCheckpoint(request, {
        action: "client_revoked",
        resourceType: "athena_client",
        resourceId: clientId,
        outcome: result.alreadyRevoked ? "already_revoked" : "revoked",
        metadata: {
          result: result.alreadyRevoked ? "already_revoked" : "revoked",
          targetIsCurrentClient: clientId === context.clientId,
        },
      });
      publishBroadcastEvent({
        namespace: "client",
        type: "revoked",
        eventPriority: "critical",
        visibility: "client",
        scope: { userId: context.userId, clientId },
        sourceClientId: context.clientId,
        payload: {
          clientId,
          revokedAt: result.client.revokedAt,
          targetIsCurrentClient: clientId === context.clientId,
        },
      });

      return response.status(200).json({
        success: true,
        revoked: !!result.revoked,
        alreadyRevoked: !!result.alreadyRevoked,
        clientId,
        revokedAt: result.client.revokedAt,
      });
    }
  );

  app.post(
    "/client-identity/revoke-all-others",
    [validatedRequest],
    async (request, response) => {
      const context = getClientContext(request);
      if (!context?.userId || context.legacy) {
        return response
          .status(401)
          .json({ success: false, error: "client_identity_required" });
      }

      const result = await revokeAllOtherClients({
        userId: context.userId,
        currentClientId: context.clientId,
      });
      void recordClientTrustCheckpoint(request, {
        action: "client_revoked_all_others",
        resourceType: "athena_client",
        resourceId: context.clientId,
        outcome: "revoked",
        metadata: {
          result: "revoked",
          revokedCount: result.count || 0,
        },
      });
      publishBroadcastEvent({
        namespace: "client",
        type: "revoked",
        eventPriority: "critical",
        visibility: "user",
        scope: { userId: context.userId },
        sourceClientId: context.clientId,
        payload: {
          revokedAllOthers: true,
          excludedClientId: context.clientId,
          revokedCount: result.count || 0,
        },
      });

      return response.status(200).json({
        success: true,
        revokedCount: result.count || 0,
      });
    }
  );

  app.post(
    "/client-identity/rotate-signing-secret",
    [validatedRequest],
    async (request, response) => {
      const context = getClientContext(request);
      if (!context?.userId || context.legacy) {
        return response
          .status(401)
          .json({ success: false, error: "client_identity_required" });
      }

      const { clientId } = reqBody(request);
      if (!clientId) {
        return response
          .status(400)
          .json({ success: false, error: "client_id_required" });
      }

      const result = await rotateSigningSecret({
        userId: context.userId,
        clientId,
        actorClientId: context.clientId,
      });
      if (!result) {
        return response
          .status(404)
          .json({ success: false, error: "client_not_found" });
      }
      if (result.revoked) {
        return response
          .status(403)
          .json({ success: false, error: CLIENT_REVOKED_ERROR });
      }

      void recordClientTrustCheckpoint(request, {
        action: "client_secret_rotated",
        resourceType: "athena_client",
        resourceId: clientId,
        outcome: "rotated",
        metadata: {
          result: "rotated",
          oldVersion: result.oldVersion,
          newVersion: result.newVersion,
          targetIsCurrentClient: clientId === context.clientId,
        },
      });
      publishBroadcastEvent({
        namespace: "signingSecret",
        type: "rotated",
        eventPriority: "critical",
        visibility: "client",
        scope: { userId: context.userId, clientId },
        sourceClientId: context.clientId,
        payload: {
          clientId,
          oldVersion: result.oldVersion,
          newVersion: result.newVersion,
        },
      });

      return response.status(200).json({
        success: true,
        rotated: true,
        clientId,
        signingSecret: result.secret || undefined,
        signingSecretVersion: result.newVersion,
        signatureVersion: SIGNATURE_VERSION,
        issuedAt: result.issuedAt,
        rotatedAt: result.rotatedAt,
      });
    }
  );

  app.post(
    "/client-identity/rotate-all-signing-secrets",
    [validatedRequest],
    async (request, response) => {
      const context = getClientContext(request);
      if (!context?.userId || context.legacy) {
        return response
          .status(401)
          .json({ success: false, error: "client_identity_required" });
      }

      const result = await rotateAllSigningSecrets({
        userId: context.userId,
        currentClientId: context.clientId,
      });

      void recordClientTrustCheckpoint(request, {
        action: "client_secret_rotated_all",
        resourceType: "athena_client",
        resourceId: context.clientId,
        outcome: "rotated",
        metadata: {
          result: "rotated",
          rotatedCount: result.count || 0,
          currentOldVersion: result.currentClient?.oldVersion || null,
          currentNewVersion: result.currentClient?.newVersion || null,
        },
      });
      publishBroadcastEvent({
        namespace: "signingSecret",
        type: "rotated",
        eventPriority: "critical",
        visibility: "user",
        scope: { userId: context.userId },
        sourceClientId: context.clientId,
        payload: {
          rotatedCount: result.count || 0,
          currentClientId: context.clientId,
          currentNewVersion: result.currentClient?.newVersion || null,
        },
      });

      return response.status(200).json({
        success: true,
        rotatedCount: result.count || 0,
        currentClient: result.currentClient
          ? {
              clientId: context.clientId,
              signingSecret: result.currentClient.secret || undefined,
              signingSecretVersion: result.currentClient.newVersion,
              signatureVersion: SIGNATURE_VERSION,
              issuedAt: result.currentClient.issuedAt,
              rotatedAt: result.currentClient.rotatedAt,
            }
          : null,
      });
    }
  );
}

module.exports = { clientIdentityEndpoints };
