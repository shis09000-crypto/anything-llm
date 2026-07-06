const prisma = require("../utils/prisma");
const { Workspace } = require("../models/workspace");

const SystemPatrolRepository = {
  dataDomain: "system-patrol",
  repositoryName: "SystemPatrolRepository",

  get workspace() {
    return Workspace;
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
    };
  },
};

module.exports = { SystemPatrolRepository };
