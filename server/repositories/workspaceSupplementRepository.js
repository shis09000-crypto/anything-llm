const prisma = require("../utils/prisma");
const { WorkspaceSupplement } = require("../models/workspaceSupplement");

const WorkspaceSupplementRepository = {
  dataDomain: "workspace-supplement",
  repositoryName: "WorkspaceSupplementRepository",

  get model() {
    return WorkspaceSupplement;
  },

  async documentByDocId({ workspaceId, documentId }) {
    return (
      await prisma.$queryRawUnsafe(
        `SELECT "docId", "filename", "docpath" FROM "workspace_documents"
        WHERE "workspaceId" = ? AND "docId" = ? LIMIT 1`,
        Number(workspaceId),
        String(documentId || "")
      )
    )?.[0];
  },
};

module.exports = { WorkspaceSupplementRepository };
