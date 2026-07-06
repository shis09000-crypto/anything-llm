const prisma = require("../utils/prisma");

const KnowledgeGraphRepository = {
  dataDomain: "knowledge-graph",
  repositoryName: "KnowledgeGraphRepository",

  get model() {
    return require("../models/knowledgeGraph").KnowledgeGraph;
  },

  get nodeSupplement() {
    return require("../models/nodeSupplement").NodeSupplement;
  },

  get systemSettings() {
    return require("../models/systemSettings").SystemSettings;
  },

  get workspace() {
    return require("../models/workspace").Workspace;
  },

  get workspaceKnowledgeProfile() {
    return require("../models/workspaceKnowledgeProfile")
      .WorkspaceKnowledgeProfile;
  },

  get bookStructureAnalysis() {
    return require("../models/workspaceKnowledgeProfile").BookStructureAnalysis;
  },

  get workspaceSupplement() {
    return require("../models/workspaceSupplement").WorkspaceSupplement;
  },

  get db() {
    return {
      $executeRawUnsafe: (...args) => prisma.$executeRawUnsafe(...args),
      $queryRawUnsafe: (...args) => prisma.$queryRawUnsafe(...args),
      executeRawUnsafe: (...args) => prisma.$executeRawUnsafe(...args),
      queryRawUnsafe: (...args) => prisma.$queryRawUnsafe(...args),
      get document_vectors() {
        return prisma.document_vectors;
      },
      get documentIndexStatus() {
        return prisma.documentIndexStatus;
      },
      get workspace_documents() {
        return prisma.workspace_documents;
      },
      get workspace_threads() {
        return prisma.workspace_threads;
      },
      get workspace_chats() {
        return prisma.workspace_chats;
      },
      get workspaces() {
        return prisma.workspaces;
      },
    };
  },
};

module.exports = { KnowledgeGraphRepository };
