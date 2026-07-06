const { WorkspaceThread } = require("../models/workspaceThread");
const { createModelRepository } = require("./createModelRepository");
const prisma = require("../utils/prisma");

const WorkspaceThreadRepository = createModelRepository(WorkspaceThread, {
  domain: "workspace-thread",
  repositoryName: "WorkspaceThreadRepository",
});

WorkspaceThreadRepository.titleMetadataSchemaReady = async function (
  fields = []
) {
  const requiredFields = Array.isArray(fields) ? fields : [];
  const prismaFields =
    prisma._runtimeDataModel?.models?.workspace_threads?.fields?.map(
      (field) => field.name
    ) || [];
  const prismaReady = requiredFields.every((field) =>
    prismaFields.includes(field)
  );

  if (typeof prisma.$queryRawUnsafe !== "function") {
    return { ready: false, prismaReady, dbReady: false };
  }

  const columns = await prisma.$queryRawUnsafe(
    'PRAGMA table_info("workspace_threads")'
  );
  const columnNames = new Set(columns.map((column) => column.name));
  const dbReady = requiredFields.every((field) => columnNames.has(field));

  return { ready: prismaReady && dbReady, prismaReady, dbReady };
};

module.exports = { WorkspaceThreadRepository };
