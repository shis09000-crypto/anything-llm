const crypto = require("crypto");
const prisma = require("../utils/prisma");
const { safeJsonParse } = require("../utils/http");

const VAULT_ITEM_ID_PREFIX = "vlt_";
const MAX_LABEL_LENGTH = 160;
const MAX_TYPE_LENGTH = 64;
const MAX_KEY_ID_LENGTH = 160;
const MAX_CRYPTO_VERSION_LENGTH = 64;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_ENCRYPTED_PAYLOAD_BYTES = 1024 * 1024;
const REQUIRED_ENCRYPTED_PAYLOAD_FIELDS = [
  "cryptoVersion",
  "algorithm",
  "keyId",
  "wrappedItemKey",
  "iv",
  "ciphertext",
];

function compactString(value = null, maxLength = 512) {
  if (value === null || value === undefined) return null;
  const next = String(value).trim();
  if (!next) return null;
  return next.slice(0, maxLength);
}

function normalizeUserId(value) {
  const userId = Number(value);
  if (!Number.isInteger(userId) || userId <= 0) return null;
  return userId;
}

function normalizeVaultItemId(value = null) {
  const existing = compactString(value, 128);
  if (existing) return existing;
  return `${VAULT_ITEM_ID_PREFIX}${
    crypto.randomUUID?.() || crypto.randomBytes(16).toString("hex")
  }`;
}

function normalizeVaultType(value = "secret") {
  return compactString(value, MAX_TYPE_LENGTH) || "secret";
}

function normalizeMetadata(metadata = {}) {
  const safeMetadata =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? metadata
      : {};
  const json = JSON.stringify(safeMetadata);
  if (Buffer.byteLength(json, "utf8") > MAX_METADATA_BYTES) {
    throw new Error("vault_metadata_too_large");
  }
  return json;
}

function normalizeEncryptedPayload(payload = null) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("vault_encrypted_payload_required");
  }

  const missing = REQUIRED_ENCRYPTED_PAYLOAD_FIELDS.filter(
    (field) => !compactString(payload[field], 4096)
  );
  if (missing.length > 0) {
    throw new Error(`vault_encrypted_payload_missing_${missing[0]}`);
  }

  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, "utf8") > MAX_ENCRYPTED_PAYLOAD_BYTES) {
    throw new Error("vault_encrypted_payload_too_large");
  }
  return json;
}

function parsedEncryptedPayload(row = null) {
  if (!row?.encryptedPayload) return null;
  return safeJsonParse(row.encryptedPayload, null);
}

function publicVaultItem(row = null, { includeEncryptedPayload = false } = {}) {
  if (!row) return null;
  return {
    id: row.itemId,
    itemId: row.itemId,
    itemType: row.itemType,
    label: row.label || null,
    keyId: row.keyId,
    cryptoVersion: row.cryptoVersion,
    metadata: safeJsonParse(row.metadataJson, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(includeEncryptedPayload
      ? { encryptedPayload: parsedEncryptedPayload(row) }
      : {}),
  };
}

const VaultItem = {
  async list({ userId, itemType = null } = {}) {
    const ownerId = normalizeUserId(userId);
    if (!ownerId) return [];
    const type = normalizeVaultType(itemType);
    const rows = itemType
      ? await prisma.$queryRaw`
          SELECT itemId, itemType, label, keyId, cryptoVersion, metadataJson, createdAt, updatedAt
          FROM vault_items
          WHERE userId = ${ownerId} AND deletedAt IS NULL AND itemType = ${type}
          ORDER BY updatedAt DESC
        `
      : await prisma.$queryRaw`
          SELECT itemId, itemType, label, keyId, cryptoVersion, metadataJson, createdAt, updatedAt
          FROM vault_items
          WHERE userId = ${ownerId} AND deletedAt IS NULL
          ORDER BY updatedAt DESC
        `;
    return rows.map((row) => publicVaultItem(row));
  },

  async get({ userId, itemId, includeEncryptedPayload = true } = {}) {
    const ownerId = normalizeUserId(userId);
    const normalizedItemId = compactString(itemId, 128);
    if (!ownerId || !normalizedItemId) return null;
    const rows = await prisma.$queryRaw`
      SELECT itemId, itemType, label, keyId, cryptoVersion, encryptedPayload, metadataJson, createdAt, updatedAt
      FROM vault_items
      WHERE userId = ${ownerId} AND itemId = ${normalizedItemId} AND deletedAt IS NULL
      LIMIT 1
    `;
    return publicVaultItem(rows?.[0], { includeEncryptedPayload });
  },

  async createOrUpdate({
    userId,
    itemId = null,
    itemType = "secret",
    label = null,
    encryptedPayload,
    keyId = null,
    cryptoVersion = null,
    metadata = {},
  } = {}) {
    const ownerId = normalizeUserId(userId);
    if (!ownerId) throw new Error("vault_user_required");

    const normalizedItemId = normalizeVaultItemId(itemId);
    const payloadJson = normalizeEncryptedPayload(encryptedPayload);
    const payload = JSON.parse(payloadJson);
    const normalizedKeyId =
      compactString(keyId, MAX_KEY_ID_LENGTH) ||
      compactString(payload.keyId, MAX_KEY_ID_LENGTH);
    const normalizedCryptoVersion =
      compactString(cryptoVersion, MAX_CRYPTO_VERSION_LENGTH) ||
      compactString(payload.cryptoVersion, MAX_CRYPTO_VERSION_LENGTH);
    if (!normalizedKeyId) throw new Error("vault_key_id_required");
    if (!normalizedCryptoVersion) throw new Error("vault_crypto_version_required");

    const normalizedType = normalizeVaultType(itemType);
    const normalizedLabel = compactString(label, MAX_LABEL_LENGTH);
    const metadataJson = normalizeMetadata(metadata);

    await prisma.$executeRaw`
      INSERT INTO vault_items (
        itemId,
        userId,
        itemType,
        label,
        keyId,
        cryptoVersion,
        encryptedPayload,
        metadataJson,
        createdAt,
        updatedAt,
        deletedAt
      )
      VALUES (
        ${normalizedItemId},
        ${ownerId},
        ${normalizedType},
        ${normalizedLabel},
        ${normalizedKeyId},
        ${normalizedCryptoVersion},
        ${payloadJson},
        ${metadataJson},
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP,
        NULL
      )
      ON CONFLICT(userId, itemId) DO UPDATE SET
        itemType = excluded.itemType,
        label = excluded.label,
        keyId = excluded.keyId,
        cryptoVersion = excluded.cryptoVersion,
        encryptedPayload = excluded.encryptedPayload,
        metadataJson = excluded.metadataJson,
        updatedAt = CURRENT_TIMESTAMP,
        deletedAt = NULL
    `;

    return this.get({
      userId: ownerId,
      itemId: normalizedItemId,
      includeEncryptedPayload: true,
    });
  },

  async delete({ userId, itemId } = {}) {
    const ownerId = normalizeUserId(userId);
    const normalizedItemId = compactString(itemId, 128);
    if (!ownerId || !normalizedItemId) return false;
    const result = await prisma.$executeRaw`
      UPDATE vault_items
      SET deletedAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP
      WHERE userId = ${ownerId} AND itemId = ${normalizedItemId} AND deletedAt IS NULL
    `;
    return Number(result || 0) > 0;
  },

  publicVaultItem,
  normalizeEncryptedPayload,
};

module.exports = { VaultItem };
