const {
  throwModelDataAccessError,
} = require("../utils/dataAccess/modelErrors");
const prisma = require("../utils/prisma");
const DocumentSyncRun = {
  statuses: {
    unknown: "unknown",
    exited: "exited",
    failed: "failed",
    success: "success",
  },

  save: async function (queueId = null, status = null, result = {}) {
    try {
      if (!this.statuses.hasOwnProperty(status))
        throw new Error(
          `DocumentSyncRun status ${status} is not a valid status.`
        );

      const run = await prisma.document_sync_executions.create({
        data: {
          queueId: Number(queueId),
          status: String(status),
          result: JSON.stringify(result),
        },
      });
      return run || null;
    } catch (error) {
      throwModelDataAccessError("documentSyncRun.save", error);
    }
  },

  get: async function (clause = {}) {
    try {
      const queue = await prisma.document_sync_executions.findFirst({
        where: clause,
      });
      return queue || null;
    } catch (error) {
      throwModelDataAccessError("documentSyncRun.get", error);
    }
  },

  where: async function (
    clause = {},
    limit = null,
    orderBy = null,
    include = {}
  ) {
    try {
      const results = await prisma.document_sync_executions.findMany({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null ? { orderBy } : {}),
        ...(include !== null ? { include } : {}),
      });
      return results;
    } catch (error) {
      throwModelDataAccessError("documentSyncRun.where", error);
    }
  },

  count: async function (clause = {}, limit = null, orderBy = {}) {
    try {
      const count = await prisma.document_sync_executions.count({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null ? { orderBy } : {}),
      });
      return count;
    } catch (error) {
      throwModelDataAccessError("documentSyncRun.count", error);
    }
  },

  delete: async function (clause = {}) {
    try {
      await prisma.document_sync_executions.deleteMany({ where: clause });
      return true;
    } catch (error) {
      throwModelDataAccessError("documentSyncRun.delete", error);
    }
  },
};

module.exports = { DocumentSyncRun };
