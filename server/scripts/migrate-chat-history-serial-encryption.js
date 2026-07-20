#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");

let auditWorkspaceChatSerialIntegrity;
let chatHistorySerialEncryptionEnabled;
let decryptChatFieldCompat;
let encryptSerialChatField;
let ensureSerialEncryptionTables;
let isSerialEncryptedChatField;
let prisma;
let rebuildChatCryptoChainForScope;
let scopeFromChat;

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function parseEnvKeyFromFile(filePath = null) {
  if (!filePath) return null;
  const fullPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(__dirname, "..", filePath);
  if (!fs.existsSync(fullPath)) throw new Error(`Legacy key file not found.`);
  const match = fs
    .readFileSync(fullPath, "utf8")
    .match(/^ENCRYPTION_MASTER_KEY=(.*)$/m);
  const key = match?.[1]?.trim()?.replace(/^['"]|['"]$/g, "") || null;
  if (!key) throw new Error(`Legacy key file has no ENCRYPTION_MASTER_KEY.`);
  return key;
}

function legacyMasterKeyConfig() {
  const envKey = String(
    process.env.LEGACY_CHAT_HISTORY_MASTER_KEY || ""
  ).trim();
  const keyFile = argValue("--legacy-key-env-file", null);
  const key = envKey || parseEnvKeyFromFile(keyFile);
  if (!key) return { key: null, source: null };
  if (!/^[a-fA-F0-9]{64}$/.test(key)) {
    throw new Error(
      "Legacy chat history master key must be a 64-character hex string."
    );
  }
  return {
    key: Buffer.from(key, "hex"),
    source: envKey ? "LEGACY_CHAT_HISTORY_MASTER_KEY" : keyFile,
  };
}

function decryptEncV1WithKey(value, key) {
  if (typeof value !== "string" || !value.startsWith("enc:v1:")) return value;
  const parts = value.split(":");
  if (parts.length !== 5) throw new Error("unsupported_enc_v1_format");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(parts[2], "base64url")
  );
  decipher.setAuthTag(Buffer.from(parts[3], "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(parts[4], "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function scopeKey(scope = {}) {
  return JSON.stringify({
    workspaceId: scope.workspaceId,
    userId: scope.userId ?? null,
    threadId: scope.threadId ?? null,
    apiSessionId: scope.apiSessionId ?? null,
  });
}

async function metadataChatIds() {
  await ensureSerialEncryptionTables();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT "chat_id" FROM "workspace_chat_crypto_metadata"`
  );
  return new Set((rows || []).map((row) => Number(row.chat_id)));
}

async function main() {
  const requestedApply = hasArg("--apply");
  const execute = hasArg("--execute");
  const apply = requestedApply && execute;
  await bootstrapCliRuntime({
    access: apply ? "write" : "read",
    execute,
    requiredTables: [
      "workspace_chats",
      "workspace_chat_crypto_metadata",
      "_prisma_migrations",
    ],
  });
  prisma = require("../utils/prisma");
  ({
    auditWorkspaceChatSerialIntegrity,
    chatHistorySerialEncryptionEnabled,
    decryptChatFieldCompat,
    encryptSerialChatField,
    ensureSerialEncryptionTables,
    isSerialEncryptedChatField,
    rebuildChatCryptoChainForScope,
    scopeFromChat,
  } = require("../utils/security/chatHistorySerialEncryption"));
  const skipFailures = hasArg("--skip-failures");
  const limit = Math.max(1, Number(argValue("--limit", 500)) || 500);
  const maxRows = Number(argValue("--max-rows", 0)) || 0;
  const encryptionReady = chatHistorySerialEncryptionEnabled();
  const legacyKey = legacyMasterKeyConfig();
  if (apply && !encryptionReady) {
    throw new Error(
      "Serial chat history encryption apply requires ENCRYPTION_MASTER_KEY."
    );
  }

  await ensureSerialEncryptionTables();
  const existingMetadata = await metadataChatIds();
  const preflight = await scanWorkspaceChatsForMigration({
    existingMetadata,
    legacyKey,
    limit,
    maxRows,
    write: false,
  });

  if (apply && preflight.decryptFailureCount > 0 && !skipFailures) {
    console.log(
      JSON.stringify(
        {
          success: false,
          mode: "apply-preflight",
          error: "Cannot apply serial migration while decrypt failures exist.",
          encryptionReady,
          legacyKeySource: legacyKey.source,
          ...preflight,
          postAudit: { skipped: true },
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }

  const stats = apply
    ? await scanWorkspaceChatsForMigration({
        existingMetadata,
        legacyKey,
        limit,
        maxRows,
        write: true,
      })
    : preflight;

  let rebuiltScopes = 0;
  if (apply) {
    for (const scope of stats.touchedScopes.values()) {
      await rebuildChatCryptoChainForScope(scope, { reencrypt: true });
      rebuiltScopes += 1;
    }
  }

  const postAudit = apply
    ? await auditWorkspaceChatSerialIntegrity()
    : { skipped: true };

  console.log(
    JSON.stringify(
      {
        success: stats.decryptFailureCount === 0 || skipFailures,
        mode: apply ? "apply" : "dry-run",
        encryptionReady,
        legacyKeySource: legacyKey.source,
        scanned: stats.scanned,
        serialV2: stats.serialV2,
        legacyOrV1: stats.legacyOrV1,
        metadataMissing: stats.metadataMissing,
        candidates: stats.candidates,
        updatedRows: stats.updatedRows,
        decryptFailureCount: stats.decryptFailureCount,
        decryptFailures: stats.decryptFailures,
        touchedScopes: stats.touchedScopes.size,
        rebuiltScopes,
        postAudit,
        ...(requestedApply && !execute
          ? {
              instruction:
                "Apply requires --apply --execute and APP_ENV or --env.",
            }
          : {}),
      },
      null,
      2
    )
  );

  if (stats.decryptFailureCount > 0 && !skipFailures) process.exitCode = 1;
}

async function scanWorkspaceChatsForMigration({
  existingMetadata,
  legacyKey,
  limit,
  maxRows,
  write = false,
}) {
  const touchedScopes = new Map();
  let cursor = null;
  let scanned = 0;
  let serialV2 = 0;
  let legacyOrV1 = 0;
  let metadataMissing = 0;
  let candidates = 0;
  let updatedRows = 0;
  let decryptFailureCount = 0;
  const decryptFailures = [];

  async function decryptForMigration(value, row, field) {
    try {
      return await decryptChatFieldCompat(value);
    } catch (error) {
      if (legacyKey.key && String(value || "").startsWith("enc:v1:")) {
        try {
          return decryptEncV1WithKey(value, legacyKey.key);
        } catch (legacyError) {
          decryptFailureCount += 1;
          if (decryptFailures.length < 20) {
            decryptFailures.push({
              id: Number(row.id),
              public_id: row.public_id || null,
              field,
              error: legacyError?.message || String(legacyError),
            });
          }
          return null;
        }
      }
      decryptFailureCount += 1;
      if (decryptFailures.length < 20) {
        decryptFailures.push({
          id: Number(row.id),
          public_id: row.public_id || null,
          field,
          error: error?.message || String(error),
        });
      }
      return null;
    }
  }

  while (true) {
    if (maxRows && scanned >= maxRows) break;
    const take = maxRows ? Math.min(limit, maxRows - scanned) : limit;
    const rows = await prisma.workspace_chats.findMany({
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: "asc" },
    });
    if (!rows.length) break;

    for (const row of rows) {
      scanned += 1;
      cursor = row.id;
      const rowIsV2 =
        isSerialEncryptedChatField(row.prompt) &&
        isSerialEncryptedChatField(row.response);
      if (rowIsV2) serialV2 += 1;
      else legacyOrV1 += 1;

      const missingMetadata = !existingMetadata.has(Number(row.id));
      if (missingMetadata) metadataMissing += 1;
      if (rowIsV2 && !missingMetadata) continue;

      candidates += 1;
      const scope = scopeFromChat(row);
      touchedScopes.set(scopeKey(scope), scope);

      const prompt = await decryptForMigration(row.prompt, row, "prompt");
      const response = await decryptForMigration(row.response, row, "response");
      if (prompt === null || response === null) continue;
      if (!write) continue;

      const encryptedPrompt = await encryptSerialChatField(prompt, scope);
      const encryptedResponse = await encryptSerialChatField(response, scope);
      if (
        encryptedPrompt !== row.prompt ||
        encryptedResponse !== row.response
      ) {
        await prisma.workspace_chats.update({
          where: { id: Number(row.id) },
          data: {
            prompt: encryptedPrompt,
            response: encryptedResponse,
            lastUpdatedAt: row.lastUpdatedAt,
          },
        });
        updatedRows += 1;
      }
    }
  }

  return {
    scanned,
    serialV2,
    legacyOrV1,
    metadataMissing,
    candidates,
    updatedRows,
    decryptFailureCount,
    decryptFailures,
    touchedScopes,
  };
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify(
        { success: false, error: error?.message || String(error) },
        null,
        2
      )
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma?.$disconnect?.().catch(() => {});
  });
