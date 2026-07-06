const { VaultItem } = require("../models/vaultItem");
const {
  assertUserScope,
  sanitizeValue,
} = require("../utils/dataAccess/dataAccessPolicy");

function encryptedPayloadEnvelope(payload = null) {
  if (!payload || typeof payload !== "object") return null;
  return {
    cryptoVersion: payload.cryptoVersion || null,
    algorithm: payload.algorithm || null,
    keyId: payload.keyId || null,
    hasWrappedItemKey: Boolean(payload.wrappedItemKey),
    hasIv: Boolean(payload.iv),
    hasCiphertext: Boolean(payload.ciphertext),
  };
}

function vaultItemEnvelope(
  item = null,
  { includeEncryptedPayload = false } = {}
) {
  if (!item) return null;
  return {
    id: item.itemId || item.id,
    itemId: item.itemId || item.id,
    itemType: item.itemType,
    label: item.label || null,
    keyId: item.keyId || null,
    cryptoVersion: item.cryptoVersion || null,
    metadata: sanitizeValue(item.metadata || {}),
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null,
    ...(includeEncryptedPayload
      ? { encryptedPayload: encryptedPayloadEnvelope(item.encryptedPayload) }
      : {}),
  };
}

const VaultRepository = {
  dataDomain: "vault",
  repositoryName: "VaultRepository",

  async listItems({ userId, itemType = null } = {}) {
    const ownerId = assertUserScope(userId, "vault.listItems");
    return VaultItem.list({ userId: ownerId, itemType });
  },

  async list({ userId, itemType = null } = {}) {
    const ownerId = assertUserScope(userId, "vault.list");
    const items = await VaultItem.list({ userId: ownerId, itemType });
    return items.map((item) => vaultItemEnvelope(item));
  },

  async getItem({ userId, itemId, includeEncryptedPayload = true } = {}) {
    const ownerId = assertUserScope(userId, "vault.getItem");
    return VaultItem.get({
      userId: ownerId,
      itemId,
      includeEncryptedPayload,
    });
  },

  async getEnvelope({ userId, itemId, includeEncryptedPayload = true } = {}) {
    const ownerId = assertUserScope(userId, "vault.getEnvelope");
    const item = await VaultItem.get({
      userId: ownerId,
      itemId,
      includeEncryptedPayload,
    });
    return vaultItemEnvelope(item, { includeEncryptedPayload });
  },

  async createOrUpdateItem(options = {}) {
    const ownerId = assertUserScope(options.userId, "vault.createOrUpdateItem");
    return VaultItem.createOrUpdate({
      ...options,
      userId: ownerId,
    });
  },

  async createOrUpdateEnvelope(options = {}) {
    const ownerId = assertUserScope(options.userId, "vault.createOrUpdate");
    const item = await VaultItem.createOrUpdate({
      ...options,
      userId: ownerId,
    });
    return vaultItemEnvelope(item, { includeEncryptedPayload: true });
  },

  async deleteItem({ userId, itemId } = {}) {
    const ownerId = assertUserScope(userId, "vault.deleteItem");
    return VaultItem.delete({ userId: ownerId, itemId });
  },

  async softDelete({ userId, itemId } = {}) {
    const ownerId = assertUserScope(userId, "vault.softDelete");
    return VaultItem.delete({ userId: ownerId, itemId });
  },

  async snapshot({ userId } = {}) {
    const ownerId = assertUserScope(userId, "vault.snapshot");
    const items = await this.list({ userId: ownerId });
    return {
      userId: ownerId,
      count: items.length,
      byType: items.reduce((acc, item) => {
        acc[item.itemType] = (acc[item.itemType] || 0) + 1;
        return acc;
      }, {}),
      items,
    };
  },
};

module.exports = {
  VaultRepository,
  vaultItemEnvelope,
  encryptedPayloadEnvelope,
};
