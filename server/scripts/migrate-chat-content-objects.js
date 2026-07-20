#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");
const { compactAgentEvents } = require("../utils/agents/toolResultStore");
const {
  assertMigrationCapacity,
  inspectMigrationCapacity,
} = require("../utils/contentObjects/migrationCapacity");

const execute = process.argv.includes("--execute");
const backupOnly = process.argv.includes("--backup-only");
const suppliedBackupPath =
  process.argv
    .find((value) => value.startsWith("--backup-path="))
    ?.slice("--backup-path=".length) || null;

function scopeFromRow(row) {
  return {
    workspaceId: Number(row.workspaceId),
    userId: row.user_id == null ? null : Number(row.user_id),
    threadId: row.thread_id == null ? null : Number(row.thread_id),
    apiSessionId:
      row.api_session_id == null ? null : String(row.api_session_id),
  };
}

function scopeKey(scope) {
  return JSON.stringify(scope);
}

function estimatedBase64Bytes(value = "") {
  const encoded = String(value).includes(",")
    ? String(value).slice(String(value).indexOf(",") + 1)
    : String(value);
  return Math.max(0, Math.floor((encoded.length * 3) / 4));
}

function classifyResponse(response = {}) {
  const attachments = Array.isArray(response.attachments)
    ? response.attachments
    : [];
  const agentEvents = Array.isArray(response.agentEvents)
    ? response.agentEvents
    : [];
  const compactedAgentEvents = compactAgentEvents(agentEvents);
  return {
    inlineAttachments: attachments.filter((item) => item?.contentString).length,
    inlineAttachmentBytes: attachments.reduce(
      (sum, item) => sum + estimatedBase64Bytes(item?.contentString || ""),
      0
    ),
    textBytes: Buffer.byteLength(String(response.text || ""), "utf8"),
    agentEventCount: agentEvents.length,
    compactedAgentEventCount: compactedAgentEvents.length,
    agentEventBytes: Buffer.byteLength(JSON.stringify(agentEvents), "utf8"),
    compactedAgentEventBytes: Buffer.byteLength(
      JSON.stringify(compactedAgentEvents),
      "utf8"
    ),
  };
}

async function backupDatabase(sourcePath, storageRoot) {
  const backupDirectory = path.join(storageRoot, "backups");
  await fs.promises.mkdir(backupDirectory, { recursive: true });
  const target = path.join(
    backupDirectory,
    `anythingllm-before-chat-objects-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.db`
  );
  const source = new Database(sourcePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    await source.backup(target);
  } finally {
    source.close();
  }
  return target;
}

async function verifiedBackup(backupPath, storageRoot) {
  const resolved = path.resolve(String(backupPath || ""));
  const backupRoot = path.resolve(storageRoot, "backups");
  const relative = path.relative(backupRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("chat_content_backup_path_invalid");
  const stat = await fs.promises.stat(resolved);
  if (!stat.isFile() || stat.size <= 0)
    throw new Error("chat_content_backup_invalid");
  return resolved;
}

async function main() {
  const runtime = await bootstrapCliRuntime({
    access: execute ? "write" : "read",
    execute,
    requiredTables:
      execute && !backupOnly
        ? [
            "workspace_chats",
            "content_objects",
            "workspace_chat_attachment_refs",
          ]
        : ["workspace_chats"],
  });
  if (backupOnly) {
    if (!execute) throw new Error("chat_content_backup_requires_execute");
    const backupPath = await backupDatabase(
      runtime.databasePath,
      runtime.storageRoot
    );
    console.log(
      JSON.stringify(
        { success: true, mode: "backup-only", backupPath },
        null,
        2
      )
    );
    return;
  }
  process.env.ATHENA_CHAT_CONTENT_OBJECTS = execute ? "write" : "off";
  const prisma = require("../utils/prisma");
  const { ContentObject } = require("../models/contentObject");
  const { prepareChatPayload } = require("../utils/contentObjects/chatPayload");
  const {
    decryptWorkspaceChatRecordAsync,
    encryptWorkspaceChatFieldAsync,
    rebuildChatCryptoChainFromChatId,
  } = require("../utils/security/chatHistoryEncryption");

  const database = new Database(runtime.databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  database.pragma("busy_timeout = 10000");
  const workspaceChatColumns = new Set(
    database
      .prepare('PRAGMA table_info("workspace_chats")')
      .all()
      .map((column) => column.name)
  );
  const payloadVersionExpression = workspaceChatColumns.has("payloadVersion")
    ? 'COALESCE("payloadVersion", 1)'
    : "1";
  const metadata = database
    .prepare(
      `SELECT id, workspaceId, user_id, thread_id, api_session_id,
              ${payloadVersionExpression} AS payloadVersion,
              length(response) AS responseBytes
       FROM workspace_chats
       WHERE ${payloadVersionExpression} < 2
       ORDER BY workspaceId, user_id, thread_id, api_session_id, id`
    )
    .all();
  const rowById = database.prepare(
    `SELECT id, workspaceId, user_id, thread_id, api_session_id,
            response, ${payloadVersionExpression} AS payloadVersion
     FROM workspace_chats WHERE id = ?`
  );
  const workspaceSlug = database.prepare(
    "SELECT slug FROM workspaces WHERE id = ? LIMIT 1"
  );
  const scopes = new Map();
  for (const row of metadata) {
    const scope = scopeFromRow(row);
    const group = scopes.get(scopeKey(scope)) || { scope, rows: [] };
    group.rows.push(row);
    scopes.set(scopeKey(scope), group);
  }

  const summary = {
    mode: execute ? "execute" : "dry-run",
    rowsInspected: 0,
    rowsMigrated: 0,
    rowsSkipped: 0,
    scopes: scopes.size,
    inlineAttachments: 0,
    inlineAttachmentBytes: 0,
    oversizedTextRows: 0,
    agentEventsBefore: 0,
    agentEventsAfter: 0,
    agentEventBytesBefore: 0,
    agentEventBytesAfter: 0,
    encryptedResponseBytesBefore: 0,
    encryptedResponseBytesAfter: 0,
    backupPath: null,
    capacity: inspectMigrationCapacity({
      databasePath: runtime.databasePath,
      storageRoot: runtime.storageRoot,
      existingBackup: Boolean(suppliedBackupPath),
    }),
  };
  if (execute) {
    summary.capacity = assertMigrationCapacity({
      databasePath: runtime.databasePath,
      storageRoot: runtime.storageRoot,
      existingBackup: Boolean(suppliedBackupPath),
    });
    summary.backupPath = suppliedBackupPath
      ? await verifiedBackup(suppliedBackupPath, runtime.storageRoot)
      : await backupDatabase(runtime.databasePath, runtime.storageRoot);
  }

  try {
    for (const group of scopes.values()) {
      const preparedRows = [];
      for (const metadataRow of group.rows) {
        const raw = rowById.get(metadataRow.id);
        const decrypted = await decryptWorkspaceChatRecordAsync(raw);
        let response;
        try {
          response = JSON.parse(decrypted.response);
        } catch {
          summary.rowsSkipped += 1;
          continue;
        }
        const classification = classifyResponse(response);
        summary.rowsInspected += 1;
        summary.inlineAttachments += classification.inlineAttachments;
        summary.inlineAttachmentBytes += classification.inlineAttachmentBytes;
        summary.encryptedResponseBytesBefore += Number(
          metadataRow.responseBytes || 0
        );
        if (classification.textBytes > 2 * 1024 * 1024)
          summary.oversizedTextRows += 1;
        summary.agentEventsBefore += classification.agentEventCount;
        summary.agentEventsAfter += classification.compactedAgentEventCount;
        summary.agentEventBytesBefore += classification.agentEventBytes;
        summary.agentEventBytesAfter += classification.compactedAgentEventBytes;
        if (!execute) continue;
        if (
          classification.inlineAttachments === 0 &&
          classification.textBytes <= 2 * 1024 * 1024 &&
          classification.agentEventBytes ===
            classification.compactedAgentEventBytes
        ) {
          summary.rowsSkipped += 1;
          continue;
        }
        const prepared = await prepareChatPayload({
          response,
          scope: group.scope,
          workspaceSlug:
            workspaceSlug.get(group.scope.workspaceId)?.slug ||
            String(group.scope.workspaceId),
        });
        const encryptedResponse = await encryptWorkspaceChatFieldAsync(
          JSON.stringify(prepared.response),
          group.scope
        );
        preparedRows.push({
          id: Number(raw.id),
          encryptedResponse,
          attachments: prepared.attachments,
          contentRefs: prepared.contentRefs,
        });
      }

      if (!execute || preparedRows.length === 0) continue;
      await prisma.$transaction(
        async (tx) => {
          for (const row of preparedRows) {
            await tx.workspace_chats.update({
              where: { id: row.id },
              data: { response: row.encryptedResponse, payloadVersion: 2 },
            });
            await ContentObject.attachToChat(tx, {
              chatId: row.id,
              attachments: row.attachments,
              contentRefs: row.contentRefs,
            });
          }
          await rebuildChatCryptoChainFromChatId(
            group.scope,
            Math.min(...preparedRows.map((row) => row.id)),
            { client: tx }
          );
        },
        { timeout: 120_000 }
      );
      summary.rowsMigrated += preparedRows.length;
      summary.encryptedResponseBytesAfter += preparedRows.reduce(
        (sum, row) => sum + Buffer.byteLength(row.encryptedResponse, "utf8"),
        0
      );
    }
  } finally {
    database.close();
    await prisma.$disconnect();
  }
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      { success: false, error: error.code || error.message },
      null,
      2
    )
  );
  process.exitCode = 1;
});
