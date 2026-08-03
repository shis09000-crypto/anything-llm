const crypto = require("crypto");
const prisma = require("../utils/prisma");
const {
  throwModelDataAccessError,
} = require("../utils/dataAccess/modelErrors");

const BrowserEgress = {
  async grant({
    userId,
    profileId,
    deviceId,
    credentialRef,
    configVersion,
    gatewayId,
    expiresAt,
    quotaConnections = 8,
  } = {}) {
    try {
      const requestedQuota = Number(quotaConnections);
      const safeQuota = Number.isFinite(requestedQuota)
        ? Math.max(1, Math.min(32, Math.trunc(requestedQuota)))
        : 8;
      return await prisma.browser_egress_grants.upsert({
        where: {
          ownerUserId_profileId_deviceId: {
            ownerUserId: Number(userId),
            profileId: String(profileId),
            deviceId: String(deviceId),
          },
        },
        create: {
          id: crypto.randomUUID(),
          ownerUserId: Number(userId),
          profileId: String(profileId),
          deviceId: String(deviceId),
          state: "active",
          credentialRef: String(credentialRef),
          configVersion: String(configVersion),
          gatewayId: String(gatewayId),
          quotaConnections: safeQuota,
          issuedAt: new Date(),
          expiresAt: new Date(expiresAt),
          revokedAt: null,
          lastHealthCode: "pending_probe",
        },
        update: {
          state: "active",
          credentialRef: String(credentialRef),
          configVersion: String(configVersion),
          gatewayId: String(gatewayId),
          quotaConnections: safeQuota,
          issuedAt: new Date(),
          expiresAt: new Date(expiresAt),
          revokedAt: null,
          lastHealthCode: "pending_probe",
        },
      });
    } catch (error) {
      throwModelDataAccessError("browserEgress.grant", error);
    }
  },

  async activeGrant({ userId, profileId, deviceId } = {}) {
    try {
      return await prisma.browser_egress_grants.findFirst({
        where: {
          ownerUserId: Number(userId),
          profileId: String(profileId),
          deviceId: String(deviceId),
          state: "active",
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
    } catch (error) {
      throwModelDataAccessError("browserEgress.activeGrant", error);
    }
  },

  async grantById({ userId, grantId } = {}) {
    try {
      return await prisma.browser_egress_grants.findFirst({
        where: { id: String(grantId), ownerUserId: Number(userId) },
      });
    } catch (error) {
      throwModelDataAccessError("browserEgress.grantById", error);
    }
  },

  async activeGrants() {
    try {
      return await prisma.browser_egress_grants.findMany({
        where: {
          state: "active",
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: "asc" },
        take: 128,
      });
    } catch (error) {
      throwModelDataAccessError("browserEgress.activeGrants", error);
    }
  },

  async renew({ userId, grantId, expiresAt } = {}) {
    try {
      const updated = await prisma.browser_egress_grants.updateMany({
        where: {
          id: String(grantId),
          ownerUserId: Number(userId),
          state: "active",
          revokedAt: null,
        },
        data: { expiresAt: new Date(expiresAt), issuedAt: new Date() },
      });
      if (updated.count !== 1) return null;
      return this.grantById({ userId, grantId });
    } catch (error) {
      throwModelDataAccessError("browserEgress.renew", error);
    }
  },

  async revoke({ userId, grantId, reasonCode = "user_revoked" } = {}) {
    try {
      const updated = await prisma.browser_egress_grants.updateMany({
        where: { id: String(grantId), ownerUserId: Number(userId) },
        data: {
          state: "revoked",
          revokedAt: new Date(),
          credentialRef: null,
          lastHealthCode: String(reasonCode).slice(0, 96),
        },
      });
      return updated.count === 1;
    } catch (error) {
      throwModelDataAccessError("browserEgress.revoke", error);
    }
  },

  async revokeDevice({ userId, deviceId } = {}) {
    try {
      return await prisma.browser_egress_grants.updateMany({
        where: {
          ownerUserId: Number(userId),
          deviceId: String(deviceId),
          state: "active",
          revokedAt: null,
        },
        data: {
          state: "revoked",
          revokedAt: new Date(),
          credentialRef: null,
          lastHealthCode: "device_revoked",
        },
      });
    } catch (error) {
      throwModelDataAccessError("browserEgress.revokeDevice", error);
    }
  },

  async recordHealth({ userId, grantId, code, handshakeAt = null } = {}) {
    try {
      const updated = await prisma.browser_egress_grants.updateMany({
        where: { id: String(grantId), ownerUserId: Number(userId) },
        data: {
          lastHealthCode: String(code || "unknown").slice(0, 96),
          ...(handshakeAt ? { lastHandshakeAt: new Date(handshakeAt) } : {}),
        },
      });
      return updated.count === 1;
    } catch (error) {
      throwModelDataAccessError("browserEgress.recordHealth", error);
    }
  },
};

module.exports = { BrowserEgress };
