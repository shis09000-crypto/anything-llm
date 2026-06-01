const prisma = require("../utils/prisma");
const { SystemSettings } = require("./systemSettings");
const { ROLES } = require("../utils/middleware/multiUserProtected");
const {
  isSecretEncrypted,
  readSecret,
  saveSecret,
} = require("../utils/security");

function maskKey(key = null) {
  if (!key || typeof key !== "string") return "";
  if (key.length <= 12) return "********";
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

function publicApiKey(apiKey = null, plainKey = null) {
  if (!apiKey) return null;
  return {
    ...apiKey,
    key:
      plainKey ||
      (isSecretEncrypted(apiKey.key) ? "********" : maskKey(apiKey.key)),
    keyMasked: !plainKey,
  };
}

const BrowserExtensionApiKey = {
  /**
   * Creates a new secret for a browser extension API key.
   * @returns {string} brx-*** API key to use with extension
   */
  makeSecret: () => {
    const uuidAPIKey = require("uuid-apikey");
    return `brx-${uuidAPIKey.create().apiKey}`;
  },

  /**
   * Creates a new api key for the browser Extension
   * @param {number|null} userId - User id to associate creation of key with.
   * @returns {Promise<{apiKey: import("@prisma/client").browser_extension_api_keys|null, error:string|null}>}
   */
  create: async function (userId = null) {
    try {
      const plainKey = this.makeSecret();
      const apiKey = await prisma.browser_extension_api_keys.create({
        data: {
          key: saveSecret(plainKey),
          user_id: userId,
        },
      });
      return { apiKey: publicApiKey(apiKey, plainKey), error: null };
    } catch (error) {
      console.error("Failed to create browser extension API key", error);
      return { apiKey: null, error: error.message };
    }
  },

  /**
   * Validated existing API key
   * @param {string} key
   * @returns {Promise<{apiKey: import("@prisma/client").browser_extension_api_keys|boolean}>}
   */
  validate: async function (key) {
    if (!key.startsWith("brx-")) return false;
    let apiKey = await prisma.browser_extension_api_keys.findUnique({
      where: { key: key.toString() },
      include: { user: true },
    });

    if (!apiKey) {
      const apiKeys = await prisma.browser_extension_api_keys.findMany({
        include: { user: true },
      });
      apiKey = apiKeys.find((candidate) => readSecret(candidate.key) === key);
    }

    if (!apiKey) return false;

    const multiUserMode = await SystemSettings.isMultiUserMode();
    if (!multiUserMode) return apiKey; // In single-user mode, all keys are valid

    // In multi-user mode, check if the key is associated with a user
    return apiKey.user_id ? apiKey : false;
  },

  /**
   * Fetches browser api key by params.
   * @param {object} clause - Prisma props for search
   * @returns {Promise<{apiKey: import("@prisma/client").browser_extension_api_keys|boolean}>}
   */
  get: async function (clause = {}) {
    try {
      const apiKey = await prisma.browser_extension_api_keys.findFirst({
        where: clause,
      });
      return apiKey;
    } catch (error) {
      console.error("FAILED TO GET BROWSER EXTENSION API KEY.", error.message);
      return null;
    }
  },

  /**
   * Deletes browser api key by db id.
   * @param {number} id - database id of browser key
   * @returns {Promise<{success: boolean, error:string|null}>}
   */
  delete: async function (id) {
    try {
      await prisma.browser_extension_api_keys.delete({
        where: { id: parseInt(id) },
      });
      return { success: true, error: null };
    } catch (error) {
      console.error("Failed to delete browser extension API key", error);
      return { success: false, error: error.message };
    }
  },

  /**
   * Deletes all browser extension API keys for a user.
   * Should be called when a user is deleted to revoke all their keys.
   * @param {number} userId - The user ID whose keys should be deleted
   * @returns {Promise<{success: boolean, error: string|null}>}
   */
  deleteAllForUser: async function (userId) {
    try {
      if (!userId) return { success: false, error: "User ID is required" };
      await prisma.browser_extension_api_keys.deleteMany({
        where: { user_id: parseInt(userId) },
      });
      return { success: true, error: null };
    } catch (error) {
      console.error(
        "Failed to delete browser extension API keys for user",
        error
      );
      return { success: false, error: error.message };
    }
  },

  /**
   * Gets browser keys by params
   * @param {object} clause
   * @param {number|null} limit
   * @param {object|null} orderBy
   * @returns {Promise<import("@prisma/client").browser_extension_api_keys[]>}
   */
  where: async function (clause = {}, limit = null, orderBy = null) {
    try {
      const apiKeys = await prisma.browser_extension_api_keys.findMany({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null ? { orderBy } : {}),
        include: { user: true },
      });
      return apiKeys.map((apiKey) => publicApiKey(apiKey));
    } catch (error) {
      console.error("FAILED TO GET BROWSER EXTENSION API KEYS.", error.message);
      return [];
    }
  },

  /**
   * Get browser API keys for user
   * @param {import("@prisma/client").users} user
   * @param {object} clause
   * @param {number|null} limit
   * @param {object|null} orderBy
   * @returns {Promise<import("@prisma/client").browser_extension_api_keys[]>}
   */
  whereWithUser: async function (
    user,
    clause = {},
    limit = null,
    orderBy = null
  ) {
    // Admin can view and use any keys
    if ([ROLES.admin].includes(user.role))
      return await this.where(clause, limit, orderBy);

    try {
      const apiKeys = await prisma.browser_extension_api_keys.findMany({
        where: {
          ...clause,
          user_id: user.id,
        },
        include: { user: true },
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null ? { orderBy } : {}),
      });
      return apiKeys.map((apiKey) => publicApiKey(apiKey));
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  /**
   * Updates owner of all DB ids to new admin.
   * @param {number} userId
   * @returns {Promise<void>}
   */
  migrateApiKeysToMultiUser: async function (userId) {
    try {
      await prisma.browser_extension_api_keys.updateMany({
        where: {
          user_id: null,
        },
        data: {
          user_id: userId,
        },
      });
      console.log("Successfully migrated API keys to multi-user mode");
    } catch (error) {
      console.error("Error migrating API keys to multi-user mode:", error);
    }
  },
};

module.exports = { BrowserExtensionApiKey };
