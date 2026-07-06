const prisma = require("../utils/prisma");

const WorkspaceOverviewRepository = {
  dataDomain: "workspace-overview",
  repositoryName: "WorkspaceOverviewRepository",

  get nodeSupplement() {
    return require("../models/nodeSupplement").NodeSupplement;
  },

  get workspaceSupplement() {
    return require("../models/workspaceSupplement").WorkspaceSupplement;
  },

  get workspaceVisualAsset() {
    return require("../models/workspaceVisualAsset").WorkspaceVisualAsset;
  },

  get workspaceOverviewNarrative() {
    return require("../models/workspaceOverviewNarrative")
      .WorkspaceOverviewNarrative;
  },

  get db() {
    return {
      $executeRawUnsafe: (...args) => prisma.$executeRawUnsafe(...args),
      $queryRawUnsafe: (...args) => prisma.$queryRawUnsafe(...args),
      executeRawUnsafe: (...args) => prisma.$executeRawUnsafe(...args),
      queryRawUnsafe: (...args) => prisma.$queryRawUnsafe(...args),
    };
  },
};

module.exports = { WorkspaceOverviewRepository };
