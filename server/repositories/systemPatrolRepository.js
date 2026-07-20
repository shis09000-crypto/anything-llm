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
      $transaction: (...args) => prisma.$transaction(...args),
      executeRawUnsafe: (...args) => prisma.$executeRawUnsafe(...args),
      queryRawUnsafe: (...args) => prisma.$queryRawUnsafe(...args),
      get document_vectors() {
        return prisma.document_vectors;
      },
      get documentIndexStatus() {
        return prisma.documentIndexStatus;
      },
      get users() {
        return prisma.users;
      },
      get system_patrol_runs() {
        return prisma.system_patrol_runs;
      },
      get system_patrol_repairs() {
        return prisma.system_patrol_repairs;
      },
      get content_objects() {
        return prisma.content_objects;
      },
    };
  },
};

module.exports = { SystemPatrolRepository };
