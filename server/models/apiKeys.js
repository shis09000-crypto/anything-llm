const {
  throwModelDataAccessError,
} = require("../utils/dataAccess/modelErrors");
const prisma = require("../utils/prisma");
const {
  isSecretEncrypted,
  readSecret,
  saveSecret,
} = require("../utils/security");

function maskSecret(secret = null) {
  if (!secret || typeof secret !== "string") return "";
  if (secret.length <= 12) return "********";
  return `${secret.slice(0, 8)}...${secret.slice(-4)}`;
}

function publicApiKey(apiKey = null, plainSecret = null) {
  if (!apiKey) return null;
  return {
    ...apiKey,
    secret:
      plainSecret ||
      (isSecretEncrypted(apiKey.secret)
        ? "********"
        : maskSecret(apiKey.secret)),
    secretMasked: !plainSecret,
  };
}

const ApiKey = {
  tablename: "api_keys",
  writable: ["name"],

  makeSecret: () => {
    const uuidAPIKey = require("uuid-apikey");
    return uuidAPIKey.create().apiKey;
  },

  create: async function (createdByUserId = null, name = null) {
    try {
      const normalizedName =
        typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
      const plainSecret = this.makeSecret();
      const apiKey = await prisma.api_keys.create({
        data: {
          name: normalizedName,
          secret: saveSecret(plainSecret),
          createdBy: createdByUserId,
        },
      });

      return { apiKey: publicApiKey(apiKey, plainSecret), error: null };
    } catch (error) {
      console.error("FAILED TO CREATE API KEY.", error.message);
      return { apiKey: null, error: error.message };
    }
  },

  rotate: async function (id, createdByUserId = null) {
    try {
      const existing = await this.get({
        id: Number(id),
        ...(createdByUserId ? { createdBy: Number(createdByUserId) } : {}),
      });
      if (!existing) return { apiKey: null, error: "API key not found." };
      const plainSecret = this.makeSecret();
      const apiKey = await prisma.api_keys.update({
        where: { id: existing.id },
        data: {
          secret: saveSecret(plainSecret),
          lastUpdatedAt: new Date(),
        },
      });
      return { apiKey: publicApiKey(apiKey, plainSecret), error: null };
    } catch (error) {
      return { apiKey: null, error: error.message };
    }
  },

  get: async function (clause = {}) {
    try {
      const apiKey = await prisma.api_keys.findFirst({ where: clause });
      return apiKey;
    } catch (error) {
      throwModelDataAccessError("apiKeys.get", error);
    }
  },

  count: async function (clause = {}) {
    try {
      const count = await prisma.api_keys.count({ where: clause });
      return count;
    } catch (error) {
      throwModelDataAccessError("apiKeys.count", error);
    }
  },

  delete: async function (clause = {}) {
    try {
      await prisma.api_keys.deleteMany({ where: clause });
      return true;
    } catch (error) {
      throwModelDataAccessError("apiKeys.delete", error);
    }
  },

  where: async function (clause = {}, limit) {
    try {
      const apiKeys = await prisma.api_keys.findMany({
        where: clause,
        take: limit,
      });
      return apiKeys.map((apiKey) => publicApiKey(apiKey));
    } catch (error) {
      throwModelDataAccessError("apiKeys.where", error);
    }
  },

  validateSecret: async function (secret = null) {
    try {
      if (!secret) return null;

      const plaintextMatch = await this.get({ secret: String(secret) });
      if (plaintextMatch) {
        if (
          !plaintextMatch.lastUsedAt ||
          Date.now() - plaintextMatch.lastUsedAt.getTime() > 300_000
        )
          prisma.api_keys
            .update({
              where: { id: plaintextMatch.id },
              data: { lastUsedAt: new Date() },
            })
            .catch(() => {});
        return plaintextMatch;
      }

      const apiKeys = await prisma.api_keys.findMany({});
      for (const apiKey of apiKeys) {
        if (readSecret(apiKey.secret) === String(secret)) {
          if (
            !apiKey.lastUsedAt ||
            Date.now() - apiKey.lastUsedAt.getTime() > 300_000
          )
            prisma.api_keys
              .update({
                where: { id: apiKey.id },
                data: { lastUsedAt: new Date() },
              })
              .catch(() => {});
          return apiKey;
        }
      }
      return null;
    } catch (error) {
      console.error("FAILED TO VALIDATE API KEY.", error.message);
      throw error;
    }
  },

  whereWithUser: async function (clause = {}, limit) {
    try {
      const { User } = require("./user");
      const apiKeys = await this.where(clause, limit);

      for (const apiKey of apiKeys) {
        if (!apiKey.createdBy) continue;
        const user = await User.get({ id: apiKey.createdBy });
        if (!user) continue;

        apiKey.createdBy = {
          id: user.id,
          username: user.username,
          role: user.role,
        };
      }

      return apiKeys;
    } catch (error) {
      throwModelDataAccessError("apiKeys.whereWithUser", error);
    }
  },
};

module.exports = { ApiKey };
