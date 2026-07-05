const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { reqBody } = require("../utils/http");
const {
  getClientContext,
  listUserClients,
  recordClientTrustCheckpoint,
  revokeAllOtherClients,
  revokeClient,
} = require("../utils/clientIdentity");
const {
  CLIENT_REVOKED_ERROR,
  SIGNATURE_VERSION,
  ensureClientSigningSecret,
  rotateAllSigningSecrets,
  rotateSigningSecret,
} = require("../utils/requestSigning");
const { publishBroadcastEvent } = require("../utils/broadcast");

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
