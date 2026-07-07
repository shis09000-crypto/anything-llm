const prisma = require("../utils/prisma");
const { MobileDevice } = require("../models/mobileDevice");

const MobileRepository = {
  dataDomain: "mobile",
  repositoryName: "MobileRepository",

  get model() {
    return MobileDevice;
  },

  get db() {
    return {
      workspaceThreads: {
        count: (options) => prisma.workspace_threads.count(options),
        findMany: (options) => prisma.workspace_threads.findMany(options),
        findFirst: (options) => prisma.workspace_threads.findFirst(options),
      },
      workspaceChats: {
        count: (options) => prisma.workspace_chats.count(options),
        findMany: (options) => prisma.workspace_chats.findMany(options),
      },
    };
  },
};

module.exports = { MobileRepository };
