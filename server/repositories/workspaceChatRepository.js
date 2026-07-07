const { WorkspaceChats } = require("../models/workspaceChats");
const { createModelRepository } = require("./createModelRepository");
const prisma = require("../utils/prisma");
const { newPublicChatId } = require("../utils/chats/chatIdentifiers");

const WorkspaceChatRepository = createModelRepository(WorkspaceChats, {
  domain: "workspace-chat",
  repositoryName: "WorkspaceChatRepository",
});

WorkspaceChatRepository.publicIdColumnExists = async function () {
  const columns = await prisma.$queryRawUnsafe(
    `PRAGMA table_info("workspace_chats")`
  );
  return columns.some((column) => column.name === "public_id");
};

WorkspaceChatRepository.backfillMissingPublicIds = async function ({
  dryRun = false,
} = {}) {
  if (!(await this.publicIdColumnExists())) {
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

  return {
    success: true,
    dryRun,
    missing: missingRows.length,
    updated,
  };
};

module.exports = { WorkspaceChatRepository };
