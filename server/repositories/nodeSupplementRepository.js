const prisma = require("../utils/prisma");
const { NodeSupplement } = require("../models/nodeSupplement");

const NodeSupplementRepository = {
  dataDomain: "node-supplement",
  repositoryName: "NodeSupplementRepository",

  get model() {
    return NodeSupplement;
  },

  get db() {
    return {
      workspaceDocuments: {
        findMany: (options) => prisma.workspace_documents.findMany(options),
      },
    };
  },
};

module.exports = { NodeSupplementRepository };
