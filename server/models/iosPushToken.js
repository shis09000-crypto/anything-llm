const crypto = require("crypto");
const prisma = require("../utils/prisma");
const { readSecret, saveSecret } = require("../utils/security");

function normalizeDeviceToken(value = "") {
  const token = String(value)
    .replace(/[<\s>]/g, "")
    .toLowerCase();
  return /^[a-f0-9]{32,256}$/.test(token) ? token : null;
}

function fingerprint(value = "") {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

const IOSPushToken = {
  register: async function ({
    userId,
    clientId,
    deviceToken,
    environment,
    bundleId,
    appVersion = null,
  }) {
    const token = normalizeDeviceToken(deviceToken);
    if (!token) throw new Error("invalid_device_token");
    const where = {
      userId_clientId_environment_bundleId: {
        userId: Number(userId),
        clientId: String(clientId),
        environment: String(environment),
        bundleId: String(bundleId),
      },
    };
    return prisma.athena_ios_push_tokens.upsert({
      where,
      create: {
        ...where.userId_clientId_environment_bundleId,
        tokenEncrypted: saveSecret(token),
        tokenFingerprint: fingerprint(token),
        appVersion: appVersion ? String(appVersion).slice(0, 64) : null,
      },
      update: {
        tokenEncrypted: saveSecret(token),
        tokenFingerprint: fingerprint(token),
        appVersion: appVersion ? String(appVersion).slice(0, 64) : null,
        lastSeenAt: new Date(),
        updatedAt: new Date(),
        revokedAt: null,
      },
    });
  },

  revoke: async function ({ userId, clientId }) {
    return prisma.athena_ios_push_tokens.updateMany({
      where: {
        userId: Number(userId),
        clientId: String(clientId),
        revokedAt: null,
      },
      data: { revokedAt: new Date(), updatedAt: new Date() },
    });
  },

  revokeById: async function (id) {
    return prisma.athena_ios_push_tokens.updateMany({
      where: { id: Number(id), revokedAt: null },
      data: { revokedAt: new Date(), updatedAt: new Date() },
    });
  },

  activeForUser: async function (userId, excludeClientId = null) {
    const rows = await prisma.athena_ios_push_tokens.findMany({
      where: {
        userId: Number(userId),
        revokedAt: null,
        ...(excludeClientId
          ? { clientId: { not: String(excludeClientId) } }
          : {}),
      },
    });
    return rows.flatMap((row) => {
      try {
        const token = readSecret(row.tokenEncrypted);
        return token ? [{ ...row, deviceToken: token }] : [];
      } catch (error) {
        console.warn("[IOSPushToken] failed to decrypt active token", {
          id: row.id,
          clientId: row.clientId,
          code: error?.code || error?.name || "push_token_decrypt_failed",
        });
        return [];
      }
    });
  },

  normalizeDeviceToken,
  fingerprint,
};

module.exports = { IOSPushToken };
