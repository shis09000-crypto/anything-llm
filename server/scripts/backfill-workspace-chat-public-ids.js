#!/usr/bin/env node
const prisma = require("../utils/prisma");
const { newPublicChatId } = require("../utils/chats/chatIdentifiers");

const dryRun = process.argv.includes("--dry-run");

async function publicIdColumnExists() {
  const columns = await prisma.$queryRawUnsafe(
    `PRAGMA table_info("workspace_chats")`
  );
  return columns.some((column) => column.name === "public_id");
}

async function backfillWorkspaceChatPublicIds() {
  if (!(await publicIdColumnExists())) {
    throw new Error(
      "workspace_chats.public_id does not exist. Run Prisma migrations first."
    );
  }

  const missingRows = await prisma.$queryRawUnsafe(`
    SELECT id
    FROM "workspace_chats"
    WHERE "public_id" IS NULL OR TRIM("public_id") = ''
    ORDER BY id ASC
  `);

  let updated = 0;
  for (const row of missingRows) {
    const publicId = newPublicChatId();
    if (!dryRun) {
      await prisma.$executeRawUnsafe(
        `UPDATE "workspace_chats" SET "public_id" = ? WHERE id = ?`,
        publicId,
        row.id
      );
    }
    updated += 1;
  }

  console.log(
    JSON.stringify(
      {
        success: true,
        dryRun,
        missing: missingRows.length,
        updated,
      },
      null,
      2
    )
  );
}

backfillWorkspaceChatPublicIds()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
