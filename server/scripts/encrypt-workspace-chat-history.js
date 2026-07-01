#!/usr/bin/env node
const prisma = require("../utils/prisma");
const {
  chatHistoryEncryptionEnabled,
  encryptWorkspaceChatField,
  workspaceChatFieldIsEncrypted,
} = require("../utils/security/chatHistoryEncryption");

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

async function main() {
  const apply = hasArg("--apply");
  const limit = Math.max(1, Number(argValue("--limit", 500)) || 500);
  const maxRows = Number(argValue("--max-rows", 0)) || 0;
  const encryptionReady = chatHistoryEncryptionEnabled();

  if (apply && !encryptionReady) {
    throw new Error(
      "CHAT history encryption apply requires ENCRYPTION_MASTER_KEY."
    );
  }

  let cursor = null;
  let scanned = 0;
  let alreadyEncrypted = 0;
  let wouldEncrypt = 0;
  let updated = 0;

  while (true) {
    if (maxRows && scanned >= maxRows) break;
    const take = maxRows ? Math.min(limit, maxRows - scanned) : limit;
    const rows = await prisma.workspace_chats.findMany({
      select: {
        id: true,
        prompt: true,
        response: true,
        lastUpdatedAt: true,
      },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: "asc" },
    });
    if (!rows.length) break;

    for (const row of rows) {
      scanned += 1;
      cursor = row.id;
      const promptEncrypted = workspaceChatFieldIsEncrypted(row.prompt);
      const responseEncrypted = workspaceChatFieldIsEncrypted(row.response);
      if (promptEncrypted && responseEncrypted) {
        alreadyEncrypted += 1;
        continue;
      }

      wouldEncrypt += 1;
      if (!apply) continue;

      await prisma.workspace_chats.update({
        where: { id: row.id },
        data: {
          ...(promptEncrypted
            ? {}
            : { prompt: encryptWorkspaceChatField(row.prompt) }),
          ...(responseEncrypted
            ? {}
            : { response: encryptWorkspaceChatField(row.response) }),
          lastUpdatedAt: row.lastUpdatedAt,
        },
      });
      updated += 1;
    }
  }

  console.log(
    JSON.stringify(
      {
        success: true,
        mode: apply ? "apply" : "dry-run",
        encryptionReady,
        scanned,
        alreadyEncrypted,
        wouldEncrypt,
        updated,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify({ success: false, error: error.message }, null, 2)
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect?.().catch(() => {});
  });
