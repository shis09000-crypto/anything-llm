const prisma = require("../utils/prisma");
const { WorkspaceChats } = require("../models/workspaceChats");
const { WorkspaceThread } = require("../models/workspaceThread");

const QuizRepository = {
  dataDomain: "quiz",
  repositoryName: "QuizRepository",

  get workspaceChats() {
    return WorkspaceChats;
  },

  get workspaceThread() {
    return WorkspaceThread;
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

module.exports = { QuizRepository };
