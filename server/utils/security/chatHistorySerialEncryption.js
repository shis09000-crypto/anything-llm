const crypto = require("crypto");
const prisma = require("../prisma");
const {
  ensureMigrationOwnedTables,
} = require("../database/schemaIntrospection");
const { decryptSecretIfNeeded, isEncryptedSecret } = require("./encryption");
const { resolveActiveKey } = require("./keyCustody");
const {
  remoteKeyCustodyEnabled,
  unwrapMaterial,
  wrapMaterial,
} = require("./keyCustody/remoteClient");
const { queueUserDomainWrap } = require("./userDomainWrapService");

const CHAT_HISTORY_CRYPTO_VERSION = "athena-chat-history:v2";
const CHAT_HISTORY_KEY_CRYPTO_VERSION = "athena-chat-key:v1";
const CHAT_HISTORY_ALGORITHM = "aes-256-gcm";
const CHAT_HISTORY_V2_PREFIX = "chat:v2:";
const CHAT_HISTORY_V2_FORMAT = "chat:v2";
const CHAT_HISTORY_SERIAL_REQUIRED_ENV =
  "CHAT_HISTORY_SERIAL_ENCRYPTION_REQUIRED";
const CHAT_HISTORY_INCREMENTAL_CHAIN_APPEND_ENV =
  "CHAT_HISTORY_INCREMENTAL_CHAIN_APPEND";
const CHAT_HISTORY_SUFFIX_CHAIN_REBUILD_ENV =
  "CHAT_HISTORY_SUFFIX_CHAIN_REBUILD";
const CONVERSATION_KEY_BYTES = 32;

let tablesReady = false;
const keyCache = new Map();
const chainRuntimeMetrics = {
  chat_chain_incremental_appends: 0,
  chat_chain_suffix_rebuilds: 0,
  chat_chain_suffix_rows: 0,
  chat_chain_full_rebuilds: 0,
  chat_chain_rebuild_fallbacks: 0,
};

function chatHistorySerialEncryptionEnabled(env = process.env) {
  if (
    String(env.CHAT_HISTORY_SERIAL_ENCRYPTION || "").toLowerCase() === "false"
  )
    return false;
  if (String(env.CHAT_HISTORY_ENCRYPTION || "").toLowerCase() === "false")
    return false;
  if (
    String(env.CHAT_HISTORY_ENCRYPTION_DISABLED || "").toLowerCase() === "true"
  )
    return false;
  if (remoteKeyCustodyEnabled(env, { purpose: "chat-conversation-key" })) {
    return true;
  }
  try {
    return Boolean(resolveActiveKey());
  } catch {
    return false;
  }
}

function chatHistorySerialEncryptionRequired(env = process.env) {
  return (
    String(env[CHAT_HISTORY_SERIAL_REQUIRED_ENV] || "").toLowerCase() === "true"
  );
}

function incrementalChatChainAppendEnabled(env = process.env) {
  return (
    String(
      env[CHAT_HISTORY_INCREMENTAL_CHAIN_APPEND_ENV] || "true"
    ).toLowerCase() !== "false"
  );
}

function suffixChatChainRebuildEnabled(env = process.env) {
  return (
    String(
      env[CHAT_HISTORY_SUFFIX_CHAIN_REBUILD_ENV] || "true"
    ).toLowerCase() !== "false"
  );
}

function isSerialEncryptedChatField(value) {
  return typeof value === "string" && value.startsWith(CHAT_HISTORY_V2_PREFIX);
}

function isAnyEncryptedChatField(value) {
  return isSerialEncryptedChatField(value) || isEncryptedSecret(value);
}

function normalizeNullableNumber(value) {
  return value === undefined || value === null || value === ""
    ? null
    : Number(value);
}

function normalizeNullableString(value) {
  return value === undefined || value === null || value === ""
    ? null
    : String(value);
}

function normalizeChatScope({
  workspaceId = null,
  workspace_id = null,
  userId = null,
  user_id = null,
  threadId = null,
  thread_id = null,
  apiSessionId = null,
  api_session_id = null,
} = {}) {
  const normalizedWorkspaceId = normalizeNullableNumber(
    workspaceId ?? workspace_id
  );
  if (!normalizedWorkspaceId)
    throw new Error("chat_history_workspace_required");
  return {
    workspaceId: normalizedWorkspaceId,
    userId: normalizeNullableNumber(userId ?? user_id),
    threadId: normalizeNullableNumber(threadId ?? thread_id),
    apiSessionId: normalizeNullableString(apiSessionId ?? api_session_id),
  };
}

function scopeFromChat(chat = {}) {
  return normalizeChatScope({
    workspaceId: chat.workspaceId,
    user_id: chat.user_id,
    thread_id: chat.thread_id,
    api_session_id: chat.api_session_id,
  });
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function scopeHash(scope = {}) {
  return sha256(canonicalJson(normalizeChatScope(scope)));
}

function cipherHash(value = "") {
  return sha256(String(value || ""));
}

function keyIdForScope(scope = {}) {
  return `ck_${scopeHash(scope).slice(0, 32)}`;
}

async function ensureSerialEncryptionTables(client = prisma) {
  if (tablesReady && client === prisma) return;
  if (
    await ensureMigrationOwnedTables(
      client,
      [
        "workspace_chats",
        "workspace_chat_conversation_keys",
        "workspace_chat_crypto_metadata",
      ],
      { context: "chat-history-serial-encryption" }
    )
  ) {
    if (client === prisma) tablesReady = true;
    return;
  }
  // The existing history index places `include` before `id`, so the chain-tail
  // safety query cannot satisfy ORDER BY id DESC from the index and becomes
  // history-length dependent. This additive index keeps the business tail
  // check O(log n) without changing chat visibility semantics.
  await client.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "workspace_chats_scope_tail_idx"
    ON "workspace_chats"("workspaceId", "user_id", "thread_id", "api_session_id", "id")
  `);
  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "workspace_chat_conversation_keys" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "key_id" TEXT NOT NULL,
      "scope_hash" TEXT NOT NULL,
      "workspace_id" INTEGER NOT NULL,
      "user_id" INTEGER,
      "thread_id" INTEGER,
      "api_session_id" TEXT,
      "wrapped_key" TEXT NOT NULL,
      "crypto_version" TEXT NOT NULL DEFAULT '${CHAT_HISTORY_KEY_CRYPTO_VERSION}',
      "algorithm" TEXT NOT NULL DEFAULT '${CHAT_HISTORY_ALGORITHM}',
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await client.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "workspace_chat_conversation_keys_key_id_key"
    ON "workspace_chat_conversation_keys"("key_id")
  `);
  await client.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "workspace_chat_conversation_keys_scope_hash_key"
    ON "workspace_chat_conversation_keys"("scope_hash")
  `);
  await client.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "workspace_chat_conversation_keys_scope_idx"
    ON "workspace_chat_conversation_keys"("workspace_id", "user_id", "thread_id", "api_session_id")
  `);
  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "workspace_chat_crypto_metadata" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "chat_id" INTEGER NOT NULL,
      "workspace_id" INTEGER NOT NULL,
      "user_id" INTEGER,
      "thread_id" INTEGER,
      "api_session_id" TEXT,
      "scope_hash" TEXT NOT NULL,
      "key_id" TEXT NOT NULL,
      "crypto_version" TEXT NOT NULL,
      "prompt_cipher_hash" TEXT NOT NULL,
      "response_cipher_hash" TEXT NOT NULL,
      "prev_chain_hash" TEXT,
      "chain_hash" TEXT NOT NULL,
      "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "workspace_chat_crypto_metadata_chat_id_fkey"
        FOREIGN KEY ("chat_id") REFERENCES "workspace_chats"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  await client.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "workspace_chat_crypto_metadata_chat_id_key"
    ON "workspace_chat_crypto_metadata"("chat_id")
  `);
  await client.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "workspace_chat_crypto_metadata_scope_chat_idx"
    ON "workspace_chat_crypto_metadata"("scope_hash", "chat_id")
  `);
  await client.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "workspace_chat_crypto_metadata_key_id_idx"
    ON "workspace_chat_crypto_metadata"("key_id")
  `);
  if (client === prisma) tablesReady = true;
}

function encryptedSecretPurpose(value) {
  const parts = String(value || "").split(":");
  if (parts[0] !== "enc" || parts[1] !== "v2" || !parts[3]) return null;
  try {
    return Buffer.from(parts[3], "base64url").toString("utf8") || null;
  } catch {
    return null;
  }
}

function conversationKeyContext(row = {}, operation = "unwrap") {
  return {
    purpose: encryptedSecretPurpose(row.wrapped_key) || "chat-conversation-key",
    domain: "chat-history",
    resource: row.key_id || "unknown",
    operation,
  };
}

async function unwrapConversationKey(row = null) {
  if (!row?.wrapped_key) return null;
  const raw = await unwrapMaterial(
    row.wrapped_key,
    conversationKeyContext(row)
  );
  return Buffer.from(raw, "base64url");
}

async function cacheKey(row = null) {
  const key = await unwrapConversationKey(row);
  if (!key) return null;
  keyCache.set(row.key_id, key);
  return key;
}

async function queueConversationKeyUserWrap(
  row,
  normalizedScope,
  client = prisma
) {
  if (!row?.key_id || !row?.wrapped_key || !normalizedScope?.userId) {
    return { queued: false, reason: "user_scope_unavailable" };
  }
  if (typeof client.users?.findUnique !== "function") {
    return { queued: false, reason: "user_domain_storage_unavailable" };
  }
  const user = await client.users.findUnique({
    where: { id: Number(normalizedScope.userId) },
    select: { id: true, authUserId: true },
  });
  if (!user?.authUserId) {
    return { queued: false, reason: "shared_identity_unavailable" };
  }
  return queueUserDomainWrap({
    userId: user.id,
    authUserId: user.authUserId,
    resourceType: "chat-conversation-key",
    resourceId: row.key_id,
    domain: "data",
    platformWrappedValue: row.wrapped_key,
    client,
  });
}

async function getConversationKeyById(keyId, client = prisma) {
  if (keyCache.has(keyId)) return keyCache.get(keyId);
  await ensureSerialEncryptionTables(client);
  const rows = await client.$queryRawUnsafe(
    `SELECT "key_id", "wrapped_key" FROM "workspace_chat_conversation_keys" WHERE "key_id" = ? LIMIT 1`,
    keyId
  );
  const key = await cacheKey(rows?.[0]);
  if (!key) throw new Error("chat_history_conversation_key_not_found");
  return key;
}

async function getOrCreateConversationKey(scope, client = prisma) {
  const normalized = normalizeChatScope(scope);
  await ensureSerialEncryptionTables(client);
  const hash = scopeHash(normalized);
  const existing = await client.$queryRawUnsafe(
    `SELECT "key_id", "wrapped_key" FROM "workspace_chat_conversation_keys" WHERE "scope_hash" = ? LIMIT 1`,
    hash
  );
  if (existing?.[0]) {
    if (!keyCache.has(existing[0].key_id)) {
      await queueConversationKeyUserWrap(existing[0], normalized, client);
    }
    return { keyId: existing[0].key_id, key: await cacheKey(existing[0]) };
  }

  const key = crypto.randomBytes(CONVERSATION_KEY_BYTES);
  const keyId = keyIdForScope(normalized);
  const wrappedKey = await wrapMaterial(key.toString("base64url"), {
    purpose: "chat-conversation-key",
    domain: "chat-history",
    resource: keyId,
    operation: "wrap",
  });
  await client.$executeRawUnsafe(
    `INSERT OR IGNORE INTO "workspace_chat_conversation_keys" (
      "key_id", "scope_hash", "workspace_id", "user_id", "thread_id", "api_session_id",
      "wrapped_key", "crypto_version", "algorithm", "created_at", "updated_at"
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    keyId,
    hash,
    normalized.workspaceId,
    normalized.userId,
    normalized.threadId,
    normalized.apiSessionId,
    wrappedKey,
    CHAT_HISTORY_KEY_CRYPTO_VERSION,
    CHAT_HISTORY_ALGORITHM
  );

  const rows = await client.$queryRawUnsafe(
    `SELECT "key_id", "wrapped_key" FROM "workspace_chat_conversation_keys" WHERE "scope_hash" = ? LIMIT 1`,
    hash
  );
  const row = rows?.[0];
  if (!row) throw new Error("chat_history_conversation_key_create_failed");
  await queueConversationKeyUserWrap(row, normalized, client);
  return { keyId: row.key_id, key: await cacheKey(row) };
}

function encryptedFieldAdditionalData(keyId) {
  return Buffer.from(
    canonicalJson({
      cryptoVersion: CHAT_HISTORY_CRYPTO_VERSION,
      format: CHAT_HISTORY_V2_FORMAT,
      algorithm: CHAT_HISTORY_ALGORITHM,
      keyId,
    }),
    "utf8"
  );
}

function parseSerialEncryptedChatField(value) {
  if (!isSerialEncryptedChatField(value)) return null;
  const parts = String(value).split(":");
  if (parts.length !== 6 || parts[0] !== "chat" || parts[1] !== "v2") {
    throw new Error("unsupported_chat_history_encryption_format");
  }
  const [, , keyId, iv, authTag, ciphertext] = parts;
  if (!keyId || !iv || !authTag || !ciphertext) {
    throw new Error("invalid_chat_history_encryption_payload");
  }
  return { keyId, iv, authTag, ciphertext };
}

async function encryptSerialChatField(value, scope, client = prisma) {
  if (value === null || value === undefined) return value;
  if (isSerialEncryptedChatField(value)) return value;
  const { keyId, key } = await getOrCreateConversationKey(scope, client);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(CHAT_HISTORY_ALGORITHM, key, iv);
  cipher.setAAD(encryptedFieldAdditionalData(keyId));
  const cipherText = Buffer.concat([
    cipher.update(String(value), "utf8"),
    cipher.final(),
  ]);
  return [
    "chat",
    "v2",
    keyId,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    cipherText.toString("base64url"),
  ].join(":");
}

async function decryptSerialChatField(value, client = prisma) {
  const payload = parseSerialEncryptedChatField(value);
  if (!payload) return value;
  const key = await getConversationKeyById(payload.keyId, client);
  const decipher = crypto.createDecipheriv(
    CHAT_HISTORY_ALGORITHM,
    key,
    Buffer.from(payload.iv, "base64url")
  );
  decipher.setAAD(encryptedFieldAdditionalData(payload.keyId));
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function chainHashPayload({
  chatId,
  publicId = null,
  scope,
  keyId,
  promptCipherHash,
  responseCipherHash,
  prevChainHash = null,
}) {
  const normalized = normalizeChatScope(scope);
  return {
    chatId: Number(chatId),
    publicId: publicId || null,
    scope: normalized,
    scopeHash: scopeHash(normalized),
    keyId,
    cryptoVersion: CHAT_HISTORY_CRYPTO_VERSION,
    promptCipherHash,
    responseCipherHash,
    prevChainHash: prevChainHash || null,
  };
}

function computeChainHash(payload) {
  return sha256(canonicalJson(payload));
}

function metadataForEncryptedChat(chat, prevChainHash = null) {
  if (!chat?.id || !isSerialEncryptedChatField(chat.prompt)) return null;
  if (!isSerialEncryptedChatField(chat.response)) return null;
  const promptPayload = parseSerialEncryptedChatField(chat.prompt);
  const responsePayload = parseSerialEncryptedChatField(chat.response);
  if (promptPayload.keyId !== responsePayload.keyId) {
    throw new Error("chat_history_key_mismatch");
  }
  const scope = scopeFromChat(chat);
  const promptCipherHash = cipherHash(chat.prompt);
  const responseCipherHash = cipherHash(chat.response);
  const payload = chainHashPayload({
    chatId: chat.id,
    publicId: chat.public_id || null,
    scope,
    keyId: promptPayload.keyId,
    promptCipherHash,
    responseCipherHash,
    prevChainHash,
  });
  return {
    chatId: Number(chat.id),
    scope,
    scopeHash: scopeHash(scope),
    keyId: promptPayload.keyId,
    cryptoVersion: CHAT_HISTORY_CRYPTO_VERSION,
    promptCipherHash,
    responseCipherHash,
    prevChainHash: prevChainHash || null,
    chainHash: computeChainHash(payload),
  };
}

function decodeSqliteTextHex(hexValue, fallback = null) {
  if (hexValue === null || hexValue === undefined) return fallback;
  const raw = String(hexValue || "");
  if (!raw) return "";
  return Buffer.from(raw, "hex").toString("utf8");
}

async function upsertChatCryptoMetadata(
  chat,
  prevChainHash = null,
  client = prisma
) {
  const metadata = metadataForEncryptedChat(chat, prevChainHash);
  if (!metadata) return null;
  await ensureSerialEncryptionTables(client);
  await client.$executeRawUnsafe(
    `INSERT INTO "workspace_chat_crypto_metadata" (
      "chat_id", "workspace_id", "user_id", "thread_id", "api_session_id", "scope_hash",
      "key_id", "crypto_version", "prompt_cipher_hash", "response_cipher_hash",
      "prev_chain_hash", "chain_hash", "created_at", "updated_at"
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT("chat_id") DO UPDATE SET
      "workspace_id" = excluded."workspace_id",
      "user_id" = excluded."user_id",
      "thread_id" = excluded."thread_id",
      "api_session_id" = excluded."api_session_id",
      "scope_hash" = excluded."scope_hash",
      "key_id" = excluded."key_id",
      "crypto_version" = excluded."crypto_version",
      "prompt_cipher_hash" = excluded."prompt_cipher_hash",
      "response_cipher_hash" = excluded."response_cipher_hash",
      "prev_chain_hash" = excluded."prev_chain_hash",
      "chain_hash" = excluded."chain_hash",
      "updated_at" = CURRENT_TIMESTAMP`,
    metadata.chatId,
    metadata.scope.workspaceId,
    metadata.scope.userId,
    metadata.scope.threadId,
    metadata.scope.apiSessionId,
    metadata.scopeHash,
    metadata.keyId,
    metadata.cryptoVersion,
    metadata.promptCipherHash,
    metadata.responseCipherHash,
    metadata.prevChainHash,
    metadata.chainHash
  );
  return metadata;
}

function whereForScope(scope = {}) {
  const normalized = normalizeChatScope(scope);
  return {
    normalized,
    where: {
      workspaceId: normalized.workspaceId,
      user_id: normalized.userId,
      thread_id: normalized.threadId,
      api_session_id: normalized.apiSessionId,
    },
  };
}

async function rebuildChatCryptoChainForScope(
  scope,
  { client = prisma, reencrypt = false } = {}
) {
  if (!chatHistorySerialEncryptionEnabled()) return { rebuilt: 0 };
  chainRuntimeMetrics.chat_chain_full_rebuilds += 1;
  await ensureSerialEncryptionTables(client);
  const scoped = whereForScope(scope);
  const rows = await client.workspace_chats.findMany({
    where: scoped.where,
    orderBy: { id: "asc" },
  });
  let prevChainHash = null;
  let rebuilt = 0;
  let reencrypted = 0;

  for (const row of rows) {
    let chat = row;
    if (
      reencrypt ||
      !isSerialEncryptedChatField(row.prompt) ||
      !isSerialEncryptedChatField(row.response)
    ) {
      const prompt = await decryptChatFieldCompat(row.prompt, client);
      const response = await decryptChatFieldCompat(row.response, client);
      const encryptedPrompt = await encryptSerialChatField(
        prompt,
        scoped.normalized,
        client
      );
      const encryptedResponse = await encryptSerialChatField(
        response,
        scoped.normalized,
        client
      );
      if (
        encryptedPrompt !== row.prompt ||
        encryptedResponse !== row.response
      ) {
        chat = await client.workspace_chats.update({
          where: { id: Number(row.id) },
          data: {
            prompt: encryptedPrompt,
            response: encryptedResponse,
            lastUpdatedAt: row.lastUpdatedAt,
          },
        });
        reencrypted += 1;
      } else {
        chat = { ...row, prompt: encryptedPrompt, response: encryptedResponse };
      }
    }

    const metadata = await upsertChatCryptoMetadata(
      chat,
      prevChainHash,
      client
    );
    prevChainHash = metadata?.chainHash || prevChainHash;
    rebuilt += 1;
  }

  return { rebuilt, reencrypted };
}

async function rebuildChatCryptoChainFromChatId(
  scope,
  startChatId,
  { client = prisma, reencrypt = false } = {}
) {
  if (!chatHistorySerialEncryptionEnabled()) {
    return { rebuilt: 0, reencrypted: 0, fallback: false };
  }
  const normalizedStartChatId = Number(startChatId);
  if (!Number.isInteger(normalizedStartChatId) || normalizedStartChatId <= 0) {
    throw new Error("chat_history_suffix_start_required");
  }
  if (!suffixChatChainRebuildEnabled()) {
    const rebuilt = await rebuildChatCryptoChainForScope(scope, {
      client,
      reencrypt,
    });
    return { ...rebuilt, fallback: false };
  }

  await ensureSerialEncryptionTables(client);
  const scoped = whereForScope(scope);
  const expectedScopeHash = scopeHash(scoped.normalized);
  const predecessorRows = await client.$queryRawUnsafe(
    `WITH "predecessor_metadata" AS (
       SELECT "chat_id", "chain_hash"
         FROM "workspace_chat_crypto_metadata"
        WHERE "scope_hash" = ?
          AND "chat_id" < ?
        ORDER BY "chat_id" DESC
        LIMIT 1
     )
     SELECT "predecessor_metadata"."chat_id",
            "predecessor_metadata"."chain_hash",
            (
              SELECT "id"
                FROM "workspace_chats"
               WHERE "workspaceId" = ?
                 AND ("user_id" = CAST(? AS INTEGER) OR ("user_id" IS NULL AND CAST(? AS INTEGER) IS NULL))
                 AND ("thread_id" = CAST(? AS INTEGER) OR ("thread_id" IS NULL AND CAST(? AS INTEGER) IS NULL))
                 AND ("api_session_id" = CAST(? AS TEXT) OR ("api_session_id" IS NULL AND CAST(? AS TEXT) IS NULL))
                 AND "id" < ?
               ORDER BY "id" DESC
               LIMIT 1
            ) AS "latest_chat_id"
       FROM (SELECT 1) AS "seed"
       LEFT JOIN "predecessor_metadata" ON 1 = 1`,
    expectedScopeHash,
    normalizedStartChatId,
    scoped.normalized.workspaceId,
    scoped.normalized.userId,
    scoped.normalized.userId,
    scoped.normalized.threadId,
    scoped.normalized.threadId,
    scoped.normalized.apiSessionId,
    scoped.normalized.apiSessionId,
    normalizedStartChatId
  );
  const predecessor = predecessorRows?.[0] || null;
  const metadataChatId =
    predecessor?.chat_id == null ? null : Number(predecessor.chat_id);
  const latestChatId =
    predecessor?.latest_chat_id == null
      ? null
      : Number(predecessor.latest_chat_id);

  if (metadataChatId !== latestChatId) {
    chainRuntimeMetrics.chat_chain_rebuild_fallbacks += 1;
    const rebuilt = await rebuildChatCryptoChainForScope(scope, {
      client,
      reencrypt,
    });
    return { ...rebuilt, fallback: true };
  }

  const rows = await client.workspace_chats.findMany({
    where: {
      ...scoped.where,
      id: { gte: normalizedStartChatId },
    },
    orderBy: { id: "asc" },
  });
  let previousHash = predecessor?.chain_hash || null;
  let rebuilt = 0;
  let reencrypted = 0;

  for (const row of rows) {
    let chat = row;
    if (
      reencrypt ||
      !isSerialEncryptedChatField(row.prompt) ||
      !isSerialEncryptedChatField(row.response)
    ) {
      const prompt = await decryptChatFieldCompat(row.prompt, client);
      const response = await decryptChatFieldCompat(row.response, client);
      const encryptedPrompt = await encryptSerialChatField(
        prompt,
        scoped.normalized,
        client
      );
      const encryptedResponse = await encryptSerialChatField(
        response,
        scoped.normalized,
        client
      );
      if (
        encryptedPrompt !== row.prompt ||
        encryptedResponse !== row.response
      ) {
        chat = await client.workspace_chats.update({
          where: { id: Number(row.id) },
          data: {
            prompt: encryptedPrompt,
            response: encryptedResponse,
            lastUpdatedAt: row.lastUpdatedAt,
          },
        });
        reencrypted += 1;
      } else {
        chat = { ...row, prompt: encryptedPrompt, response: encryptedResponse };
      }
    }

    const metadata = await upsertChatCryptoMetadata(chat, previousHash, client);
    if (!metadata) {
      chainRuntimeMetrics.chat_chain_rebuild_fallbacks += 1;
      const fallback = await rebuildChatCryptoChainForScope(scope, {
        client,
        reencrypt,
      });
      return { ...fallback, fallback: true };
    }
    previousHash = metadata.chainHash;
    rebuilt += 1;
  }

  chainRuntimeMetrics.chat_chain_suffix_rebuilds += 1;
  chainRuntimeMetrics.chat_chain_suffix_rows += rebuilt;
  return {
    rebuilt,
    reencrypted,
    startChatId: normalizedStartChatId,
    fallback: false,
  };
}

async function appendChatCryptoMetadataForRows(
  rows = [],
  scope,
  { client = prisma } = {}
) {
  if (!chatHistorySerialEncryptionEnabled()) {
    return { appended: 0, rebuilt: 0, fallback: false };
  }

  const chats = [...(Array.isArray(rows) ? rows : [rows])]
    .filter(Boolean)
    .sort((left, right) => Number(left.id) - Number(right.id));
  if (!chats.length) return { appended: 0, rebuilt: 0, fallback: false };

  if (!incrementalChatChainAppendEnabled()) {
    const rebuilt = await rebuildChatCryptoChainForScope(scope, { client });
    return { appended: 0, ...rebuilt, fallback: false };
  }

  await ensureSerialEncryptionTables(client);
  const scoped = whereForScope(scope);
  const expectedScopeHash = scopeHash(scoped.normalized);
  const firstId = Number(chats[0].id);
  const invalidScope = chats.some(
    (chat) => scopeHash(scopeFromChat(chat)) !== expectedScopeHash
  );
  const tailRows = await client.$queryRawUnsafe(
    `WITH "tail" AS (
       SELECT "chat_id", "chain_hash"
         FROM "workspace_chat_crypto_metadata"
        WHERE "scope_hash" = ?
        ORDER BY "chat_id" DESC
        LIMIT 1
     )
     SELECT "tail"."chat_id",
            "tail"."chain_hash",
            (
              SELECT "id"
                FROM "workspace_chats"
               WHERE "workspaceId" = ?
                 AND ("user_id" = CAST(? AS INTEGER) OR ("user_id" IS NULL AND CAST(? AS INTEGER) IS NULL))
                 AND ("thread_id" = CAST(? AS INTEGER) OR ("thread_id" IS NULL AND CAST(? AS INTEGER) IS NULL))
                 AND ("api_session_id" = CAST(? AS TEXT) OR ("api_session_id" IS NULL AND CAST(? AS TEXT) IS NULL))
                 AND "id" < ?
               ORDER BY "id" DESC
               LIMIT 1
            ) AS "latest_chat_id"
       FROM (SELECT 1) AS "seed"
       LEFT JOIN "tail" ON 1 = 1`,
    expectedScopeHash,
    scoped.normalized.workspaceId,
    scoped.normalized.userId,
    scoped.normalized.userId,
    scoped.normalized.threadId,
    scoped.normalized.threadId,
    scoped.normalized.apiSessionId,
    scoped.normalized.apiSessionId,
    firstId
  );
  const tail = tailRows?.[0] || null;
  const tailId = tail?.chat_id == null ? null : Number(tail.chat_id);
  const latestChatId =
    tail?.latest_chat_id == null ? null : Number(tail.latest_chat_id);

  let requiresRepair =
    invalidScope ||
    (tailId !== null && tailId >= firstId) ||
    latestChatId !== tailId;

  if (requiresRepair) {
    chainRuntimeMetrics.chat_chain_rebuild_fallbacks += 1;
    const rebuilt = await rebuildChatCryptoChainForScope(scope, { client });
    return { appended: 0, ...rebuilt, fallback: true };
  }

  let previousHash = tailId === null ? null : tail?.chain_hash || null;
  for (const chat of chats) {
    const metadata = await upsertChatCryptoMetadata(chat, previousHash, client);
    if (!metadata) {
      chainRuntimeMetrics.chat_chain_rebuild_fallbacks += 1;
      const rebuilt = await rebuildChatCryptoChainForScope(scope, { client });
      return { appended: 0, ...rebuilt, fallback: true };
    }
    previousHash = metadata.chainHash;
  }
  chainRuntimeMetrics.chat_chain_incremental_appends += chats.length;
  return { appended: chats.length, rebuilt: 0, fallback: false };
}

function chatChainRuntimeMetrics() {
  return { ...chainRuntimeMetrics };
}

function resetChatChainRuntimeMetrics() {
  for (const key of Object.keys(chainRuntimeMetrics)) {
    chainRuntimeMetrics[key] = 0;
  }
}

async function decryptChatFieldCompat(value, client = prisma) {
  if (isSerialEncryptedChatField(value))
    return decryptSerialChatField(value, client);
  if (isEncryptedSecret(value) && remoteKeyCustodyEnabled()) {
    return unwrapMaterial(value, {
      purpose: encryptedSecretPurpose(value) || "secret-store",
      domain: "chat-history",
      resource: "legacy-chat-field",
      operation: "legacy-unwrap",
    });
  }
  return decryptSecretIfNeeded(value);
}

async function decryptChatRecordCompat(chat = null, client = prisma) {
  if (!chat) return chat;
  return {
    ...chat,
    prompt: await decryptChatFieldCompat(chat.prompt, client),
    response: await decryptChatFieldCompat(chat.response, client),
  };
}

async function decryptChatRecordsCompat(chats = [], client = prisma) {
  if (!Array.isArray(chats)) return [];
  const records = [];
  for (const chat of chats)
    records.push(await decryptChatRecordCompat(chat, client));
  return records;
}

async function loadChatAuditRows(client) {
  const rows = [];
  let cursor = 0;

  while (true) {
    const rawRows = await client.$queryRawUnsafe(
      `SELECT "id",
              CASE WHEN "public_id" IS NULL THEN NULL ELSE hex("public_id") END AS "public_id_hex",
              "workspaceId",
              hex("prompt") AS "prompt_hex",
              hex("response") AS "response_hex",
              "user_id",
              "thread_id",
              CASE WHEN "api_session_id" IS NULL THEN NULL ELSE hex("api_session_id") END AS "api_session_id_hex"
         FROM "workspace_chats"
        WHERE "id" > ${Number(cursor)}
        ORDER BY "id" ASC
        LIMIT 25`
    );
    if (!rawRows?.length) break;

    for (const row of rawRows) {
      rows.push({
        id: Number(row.id),
        public_id: decodeSqliteTextHex(row.public_id_hex, null),
        workspaceId: Number(row.workspaceId),
        prompt: decodeSqliteTextHex(row.prompt_hex, ""),
        response: decodeSqliteTextHex(row.response_hex, ""),
        user_id: row.user_id === null ? null : Number(row.user_id),
        thread_id: row.thread_id === null ? null : Number(row.thread_id),
        api_session_id: decodeSqliteTextHex(row.api_session_id_hex, null),
      });
    }

    cursor = Number(rawRows[rawRows.length - 1].id);
  }

  return rows;
}

async function loadChatMetadataAuditRows(client) {
  const rows = [];
  let cursor = 0;

  while (true) {
    const rawRows = await client.$queryRawUnsafe(
      `SELECT "chat_id",
              CASE WHEN "key_id" IS NULL THEN NULL ELSE hex("key_id") END AS "key_id_hex",
              CASE WHEN "crypto_version" IS NULL THEN NULL ELSE hex("crypto_version") END AS "crypto_version_hex",
              CASE WHEN "prompt_cipher_hash" IS NULL THEN NULL ELSE hex("prompt_cipher_hash") END AS "prompt_cipher_hash_hex",
              CASE WHEN "response_cipher_hash" IS NULL THEN NULL ELSE hex("response_cipher_hash") END AS "response_cipher_hash_hex",
              "workspace_id",
              "user_id",
              "thread_id",
              CASE WHEN "api_session_id" IS NULL THEN NULL ELSE hex("api_session_id") END AS "api_session_id_hex",
              CASE WHEN "scope_hash" IS NULL THEN NULL ELSE hex("scope_hash") END AS "scope_hash_hex",
              CASE WHEN "prev_chain_hash" IS NULL THEN NULL ELSE hex("prev_chain_hash") END AS "prev_chain_hash_hex",
              CASE WHEN "chain_hash" IS NULL THEN NULL ELSE hex("chain_hash") END AS "chain_hash_hex"
         FROM "workspace_chat_crypto_metadata"
        WHERE "chat_id" > ${Number(cursor)}
        ORDER BY "chat_id" ASC
        LIMIT 200`
    );
    if (!rawRows?.length) break;

    for (const row of rawRows) {
      rows.push({
        chat_id: Number(row.chat_id),
        key_id: decodeSqliteTextHex(row.key_id_hex, null),
        crypto_version: decodeSqliteTextHex(row.crypto_version_hex, null),
        prompt_cipher_hash: decodeSqliteTextHex(
          row.prompt_cipher_hash_hex,
          null
        ),
        response_cipher_hash: decodeSqliteTextHex(
          row.response_cipher_hash_hex,
          null
        ),
        workspace_id:
          row.workspace_id === null ? null : Number(row.workspace_id),
        user_id: row.user_id === null ? null : Number(row.user_id),
        thread_id: row.thread_id === null ? null : Number(row.thread_id),
        api_session_id: decodeSqliteTextHex(row.api_session_id_hex, null),
        scope_hash: decodeSqliteTextHex(row.scope_hash_hex, null),
        prev_chain_hash: decodeSqliteTextHex(row.prev_chain_hash_hex, null),
        chain_hash: decodeSqliteTextHex(row.chain_hash_hex, null),
      });
    }

    cursor = Number(rawRows[rawRows.length - 1].chat_id);
  }

  return rows;
}

async function auditWorkspaceChatSerialIntegrity({ client = prisma } = {}) {
  await ensureSerialEncryptionTables(client);
  const rows = await loadChatAuditRows(client);
  const metadataRows = await loadChatMetadataAuditRows(client);
  const metadataByChatId = new Map(
    (metadataRows || []).map((row) => [Number(row.chat_id), row])
  );
  const chainByScope = new Map();
  const invalid = [];
  let v2 = 0;
  let legacy = 0;
  let missingMetadata = 0;

  for (const row of rows) {
    const promptV2 = isSerialEncryptedChatField(row.prompt);
    const responseV2 = isSerialEncryptedChatField(row.response);
    if (promptV2 && responseV2) v2 += 1;
    else legacy += 1;

    const metadata = metadataByChatId.get(Number(row.id));
    if (!metadata) {
      missingMetadata += 1;
      continue;
    }

    try {
      const expected = metadataForEncryptedChat(
        row,
        chainByScope.get(metadata.scope_hash) || null
      );
      const scopeMatches =
        expected &&
        metadata.scope_hash === expected.scopeHash &&
        Number(metadata.workspace_id) === expected.scope.workspaceId &&
        (metadata.user_id === null ? null : Number(metadata.user_id)) ===
          expected.scope.userId &&
        (metadata.thread_id === null ? null : Number(metadata.thread_id)) ===
          expected.scope.threadId &&
        (metadata.api_session_id || null) === expected.scope.apiSessionId;
      if (!scopeMatches) {
        invalid.push({
          chatId: Number(row.id),
          reason: "metadata_scope_mismatch",
        });
      }
      if (!expected || expected.chainHash !== metadata.chain_hash) {
        invalid.push({
          chatId: Number(row.id),
          reason: "chain_hash_mismatch",
        });
      } else if (
        (metadata.prev_chain_hash || null) !== expected.prevChainHash
      ) {
        invalid.push({
          chatId: Number(row.id),
          reason: "prev_chain_hash_mismatch",
        });
      }
      chainByScope.set(metadata.scope_hash, metadata.chain_hash);
    } catch (error) {
      invalid.push({
        chatId: Number(row.id),
        reason: error?.message || String(error),
      });
    }
  }

  return {
    available: true,
    table: "workspace_chat_crypto_metadata",
    total: rows.length,
    serialV2: v2,
    legacyOrV1: legacy,
    metadataTotal: metadataRows.length,
    metadataMissing: missingMetadata,
    chainInvalid: invalid.length,
    invalidSamples: invalid.slice(0, 20),
    required: chatHistorySerialEncryptionRequired(),
  };
}

module.exports = {
  CHAT_HISTORY_ALGORITHM,
  CHAT_HISTORY_CRYPTO_VERSION,
  CHAT_HISTORY_KEY_CRYPTO_VERSION,
  CHAT_HISTORY_INCREMENTAL_CHAIN_APPEND_ENV,
  CHAT_HISTORY_SERIAL_REQUIRED_ENV,
  CHAT_HISTORY_SUFFIX_CHAIN_REBUILD_ENV,
  CHAT_HISTORY_V2_PREFIX,
  auditWorkspaceChatSerialIntegrity,
  appendChatCryptoMetadataForRows,
  chatChainRuntimeMetrics,
  chatHistorySerialEncryptionEnabled,
  chatHistorySerialEncryptionRequired,
  decryptChatFieldCompat,
  decryptChatRecordCompat,
  decryptChatRecordsCompat,
  ensureSerialEncryptionTables,
  encryptSerialChatField,
  getOrCreateConversationKey,
  isAnyEncryptedChatField,
  isSerialEncryptedChatField,
  incrementalChatChainAppendEnabled,
  normalizeChatScope,
  rebuildChatCryptoChainForScope,
  rebuildChatCryptoChainFromChatId,
  scopeFromChat,
  resetChatChainRuntimeMetrics,
  suffixChatChainRebuildEnabled,
  upsertChatCryptoMetadata,
};
