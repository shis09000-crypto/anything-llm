const {
  throwModelDataAccessError,
} = require("../utils/dataAccess/modelErrors");
const prisma = require("../utils/prisma");
const { safeJsonParse } = require("../utils/http");

const EmbeddingBatchJob = {
  statuses: {
    queued: "queued",
    file_uploaded: "file_uploaded",
    submitted: "submitted",
    polling: "polling",
    retrying: "retrying",
    completed: "completed",
    failed: "failed",
    cancelled: "cancelled",
  },

  activeStatuses: [
    "queued",
    "file_uploaded",
    "submitted",
    "polling",
    "retrying",
  ],

  create: async function ({
    jobId,
    workspaceId,
    workspaceSlug,
    documentIds = [],
    documentPaths = [],
    provider,
    model,
    createdBy = null,
  }) {
    try {
      const job = await prisma.embedding_batch_jobs.create({
        data: {
          jobId,
          workspaceId,
          workspaceSlug,
          documentIds: JSON.stringify(documentIds),
          documentPaths: JSON.stringify(documentPaths),
          provider,
          model,
          createdBy: createdBy ? Number(createdBy) : null,
          status: this.statuses.queued,
        },
      });
      await this.logEvent(jobId, "queued", { documentPaths });
      return { job, error: null };
    } catch (error) {
      console.error("Failed to create embedding batch job.", error.message);
      return { job: null, error: error.message };
    }
  },

  get: async function (clause = {}) {
    try {
      const job = await prisma.embedding_batch_jobs.findFirst({
        where: clause,
      });
      return job ? this.inflate(job) : null;
    } catch (error) {
      throwModelDataAccessError("embeddingBatchJob.get", error);
    }
  },

  where: async function (clause = {}, limit = null, orderBy = null) {
    try {
      const jobs = await prisma.embedding_batch_jobs.findMany({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
        orderBy: orderBy || { createdAt: "desc" },
      });
      return jobs.map((job) => this.inflate(job));
    } catch (error) {
      throwModelDataAccessError("embeddingBatchJob.where", error);
    }
  },

  listWithEvents: async function (limit = 50) {
    const jobs = await this.where({}, limit, { createdAt: "desc" });
    for (const job of jobs) {
      job.events = await this.events(job.jobId, 10);
      job.graphStatus = await this.graphStatus(job.documentIds);
    }
    return jobs;
  },

  graphStatus: async function (documentIds = []) {
    const ids = Array.isArray(documentIds)
      ? documentIds.filter((id) => typeof id === "string" && id.length > 0)
      : [];
    const empty = {
      status: "not_started",
      total: 0,
      completed: 0,
      pending: 0,
      processing: 0,
      failed: 0,
    };
    if (ids.length === 0) return empty;

    try {
      const placeholders = ids.map(() => "?").join(",");
      const rows = await prisma.$queryRawUnsafe(
        `SELECT "status", COUNT(*) AS count
         FROM "GraphExtractionJob"
         WHERE "documentId" IN (${placeholders})
         GROUP BY "status"`,
        ...ids
      );
      const counts = rows.reduce(
        (acc, row) => {
          const status = String(row.status || "");
          if (!Object.prototype.hasOwnProperty.call(acc, status)) return acc;
          acc[status] = Number(row.count || 0);
          acc.total += Number(row.count || 0);
          return acc;
        },
        { ...empty, status: "not_started" }
      );

      if (counts.total === 0) return counts;
      if (counts.processing > 0) counts.status = "processing";
      else if (counts.pending > 0) counts.status = "pending";
      else if (counts.failed > 0 && counts.completed > 0)
        counts.status = "partial_failed";
      else if (counts.failed > 0) counts.status = "failed";
      else counts.status = "completed";
      return counts;
    } catch (error) {
      console.error("Failed to resolve batch job graph status.", error.message);
      return { ...empty, status: "unknown" };
    }
  },

  recoverable: async function () {
    return await this.where({ status: { in: this.activeStatuses } }, null, {
      updatedAt: "asc",
    });
  },

  update: async function (jobId, data = {}) {
    try {
      const job = await prisma.embedding_batch_jobs.update({
        where: { jobId },
        data: {
          ...data,
          updatedAt: new Date(),
        },
      });
      return { job: this.inflate(job), error: null };
    } catch (error) {
      console.error("Failed to update embedding batch job.", error.message);
      return { job: null, error: error.message };
    }
  },

  setStatus: async function (jobId, status, metadata = {}) {
    const data = { status };
    if ([this.statuses.completed, this.statuses.failed].includes(status))
      data.completedAt = new Date();
    if (status === this.statuses.failed) data.nextRetryAt = null;
    if (metadata.error) data.lastError = String(metadata.error);
    if (metadata.retryCount !== undefined)
      data.retryCount = Number(metadata.retryCount);

    const result = await this.update(jobId, data);
    await this.logEvent(jobId, status, metadata);
    return result;
  },

  scheduleRetry: async function (jobId, { error, retryCount, nextRetryAt }) {
    const errorMessage = String(error?.message || error || "Unknown error");
    const result = await this.update(jobId, {
      status: this.statuses.retrying,
      retryCount,
      nextRetryAt,
      lastTransientError: errorMessage,
      lastError: errorMessage,
      completedAt: null,
    });
    await this.logEvent(jobId, "retry_scheduled", {
      error: errorMessage,
      retryCount,
      nextRetryAt: nextRetryAt.toISOString(),
    });
    return result;
  },

  resumePolling: async function (jobId, metadata = {}) {
    const result = await this.update(jobId, {
      status: this.statuses.polling,
      nextRetryAt: null,
      completedAt: null,
      ...(metadata.resetRetryCount ? { retryCount: 0 } : {}),
    });
    await this.logEvent(jobId, metadata.event || "resume_polling", {
      status: this.statuses.polling,
      ...(metadata.reason ? { reason: metadata.reason } : {}),
    });
    await prisma.workspace_documents
      .updateMany({
        where: { embeddingBatchJobId: jobId, embeddingStatus: "failed" },
        data: {
          embeddingStatus: "processing",
          embeddingError: null,
          lastUpdatedAt: new Date(),
        },
      })
      .catch(() => null);
    const retryDocs = await prisma.workspace_documents
      .findMany({
        where: { embeddingBatchJobId: jobId },
        select: { workspaceId: true, docId: true, docpath: true },
      })
      .catch(() => []);
    const { DocumentIndexStatus } = require("./documentIndexStatus");
    await Promise.all(
      retryDocs.map((doc) =>
        DocumentIndexStatus.markIndexing({
          workspaceId: doc.workspaceId,
          docId: doc.docId,
          filePath: doc.docpath,
        })
      )
    ).catch(() => null);
    return result;
  },

  fail: async function (jobId, error, metadata = {}) {
    await this.setStatus(jobId, this.statuses.failed, {
      error: String(error?.message || error || "Unknown error"),
      ...metadata,
    });
    const errorMessage = String(error?.message || error || "Unknown error");
    const failedDocs = await prisma.workspace_documents
      .findMany({
        where: { embeddingBatchJobId: jobId },
        select: { workspaceId: true, docId: true, docpath: true },
      })
      .catch(() => []);
    const { DocumentIndexStatus } = require("./documentIndexStatus");
    await Promise.all(
      failedDocs.map((doc) =>
        DocumentIndexStatus.markFailed({
          workspaceId: doc.workspaceId,
          docId: doc.docId,
          filePath: doc.docpath,
          errorMessage,
        })
      )
    ).catch(() => null);

    return await prisma.workspace_documents
      .updateMany({
        where: { embeddingBatchJobId: jobId },
        data: {
          embeddingStatus: "failed",
          embeddingError: errorMessage,
          lastUpdatedAt: new Date(),
        },
      })
      .catch(() => null);
  },

  logEvent: async function (jobId, event, metadata = {}) {
    try {
      const eventLog = await prisma.embedding_batch_job_events.create({
        data: {
          jobId,
          event,
          metadata: metadata ? JSON.stringify(metadata) : null,
          occurredAt: new Date(),
        },
      });
      return { eventLog, error: null };
    } catch (error) {
      console.error(
        `Failed to log embedding batch job event ${event}.`,
        error.message
      );
      return { eventLog: null, error: error.message };
    }
  },

  events: async function (jobId, limit = 10) {
    try {
      return await prisma.embedding_batch_job_events.findMany({
        where: { jobId },
        take: limit,
        orderBy: { occurredAt: "desc" },
      });
    } catch (error) {
      throwModelDataAccessError("embeddingBatchJob.events", error);
    }
  },

  inflate: function (job) {
    return {
      ...job,
      documentIds: safeJsonParse(job.documentIds, []),
      documentPaths: safeJsonParse(job.documentPaths, []),
    };
  },
};

module.exports = { EmbeddingBatchJob };
