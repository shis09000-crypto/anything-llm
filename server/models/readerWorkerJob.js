const {
  throwModelDataAccessError,
} = require("../utils/dataAccess/modelErrors");
const crypto = require("crypto");
const prisma = require("../utils/prisma");

const PRIORITY_WEIGHT = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
  P4: 4,
};

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function serializeJson(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value || {});
}

function publicJob(row = null) {
  if (!row) return null;
  return {
    ...row,
    payload: parseJson(row.payloadJson, {}),
    result: parseJson(row.resultJson, null),
    payloadJson: undefined,
    resultJson: undefined,
  };
}

function orderCandidates(candidates = []) {
  return [...candidates].sort((a, b) => {
    const priorityDelta =
      (PRIORITY_WEIGHT[a.priority] ?? PRIORITY_WEIGHT.P4) -
      (PRIORITY_WEIGHT[b.priority] ?? PRIORITY_WEIGHT.P4);
    if (priorityDelta !== 0) return priorityDelta;
    return new Date(a.runAfter).getTime() - new Date(b.runAfter).getTime();
  });
}

const ReaderWorkerJob = {
  statuses: {
    queued: "queued",
    running: "running",
    completed: "completed",
    failed: "failed",
    cancelled: "cancelled",
  },

  terminalStatuses: ["completed", "failed", "cancelled"],

  enabled(env = process.env) {
    return String(env.ATHENA_READER_WORKER_QUEUE || "false") === "true";
  },

  async enqueue(options = {}) {
    const readerDocumentId = String(options.readerDocumentId || "").trim();
    const task = String(options.task || "").trim();
    if (!readerDocumentId || !task) return null;

    const jobId =
      options.jobId ||
      `reader-${Date.now()}-${crypto.randomUUID().replace(/-/g, "")}`;
    const data = {
      jobId,
      queue: options.queue || "reader",
      task,
      status: this.statuses.queued,
      priority: options.priority || "P4",
      intent: options.intent || "maintenance",
      userId: options.userId ? Number(options.userId) : null,
      workspaceSlug: options.workspaceSlug || null,
      readerDocumentId,
      payloadJson: serializeJson(options.payload || {}),
      maxAttempts: Number(options.maxAttempts || 3),
      runAfter: options.runAfter ? new Date(options.runAfter) : new Date(),
      updatedAt: new Date(),
    };

    try {
      const existing = await prisma.reader_worker_jobs.findUnique({
        where: { jobId },
      });
      if (existing && !this.terminalStatuses.includes(existing.status))
        return publicJob(existing);
      if (existing) {
        const row = await prisma.reader_worker_jobs.update({
          where: { jobId },
          data: {
            ...data,
            attempts: 0,
            lockedBy: null,
            lockedAt: null,
            startedAt: null,
            completedAt: null,
            resultJson: null,
            error: null,
          },
        });
        return publicJob(row);
      }

      const row = await prisma.reader_worker_jobs.create({ data });
      return publicJob(row);
    } catch (error) {
      throwModelDataAccessError("readerWorkerJob.enqueue", error);
    }
  },

  async get(clause = {}) {
    try {
      const row = await prisma.reader_worker_jobs.findFirst({ where: clause });
      return publicJob(row);
    } catch (error) {
      throwModelDataAccessError("readerWorkerJob.get", error);
    }
  },

  async where(clause = {}, limit = 100, orderBy = null) {
    try {
      const rows = await prisma.reader_worker_jobs.findMany({
        where: clause,
        ...(limit ? { take: Number(limit) } : {}),
        ...(orderBy ? { orderBy } : {}),
      });
      return rows.map(publicJob);
    } catch (error) {
      throwModelDataAccessError("readerWorkerJob.where", error);
    }
  },

  async claimNext({
    workerId,
    now = new Date(),
    limit = 25,
    lockTtlMs = 10 * 60 * 1000,
  } = {}) {
    const staleLockedBefore = new Date(now.getTime() - lockTtlMs);
    try {
      const candidates = await prisma.reader_worker_jobs.findMany({
        where: {
          OR: [
            { status: this.statuses.queued, runAfter: { lte: now } },
            {
              status: this.statuses.running,
              lockedAt: { lte: staleLockedBefore },
            },
          ],
        },
        take: Number(limit || 25),
      });

      for (const candidate of orderCandidates(candidates)) {
        if (
          candidate.status === this.statuses.running &&
          candidate.attempts >= candidate.maxAttempts
        ) {
          await prisma.reader_worker_jobs.updateMany({
            where: { id: candidate.id, status: this.statuses.running },
            data: {
              status: this.statuses.failed,
              error: "Reader worker job exceeded max attempts.",
              completedAt: now,
              lockedBy: null,
              lockedAt: null,
              updatedAt: now,
            },
          });
          continue;
        }
        const result = await prisma.reader_worker_jobs.updateMany({
          where: {
            id: candidate.id,
            status: candidate.status,
            attempts: candidate.attempts,
          },
          data: {
            status: this.statuses.running,
            lockedBy: workerId || "reader-worker",
            lockedAt: now,
            startedAt: candidate.startedAt || now,
            attempts: { increment: 1 },
            updatedAt: now,
            error: null,
          },
        });
        if (result.count !== 1) continue;
        return await this.get({ id: candidate.id });
      }
      return null;
    } catch (error) {
      throwModelDataAccessError("readerWorkerJob.claimNext", error);
    }
  },

  async complete(jobId, result = {}) {
    try {
      const row = await prisma.reader_worker_jobs.update({
        where: { jobId },
        data: {
          status: this.statuses.completed,
          resultJson: serializeJson(result),
          completedAt: new Date(),
          lockedBy: null,
          lockedAt: null,
          updatedAt: new Date(),
        },
      });
      return publicJob(row);
    } catch (error) {
      throwModelDataAccessError("readerWorkerJob.complete", error);
    }
  },

  async fail(
    jobId,
    errorMessage,
    { retry = true, retryDelayMs = 30_000 } = {}
  ) {
    try {
      const job = await prisma.reader_worker_jobs.findUnique({
        where: { jobId },
      });
      if (!job) return null;
      const canRetry = retry && job.attempts < job.maxAttempts;
      const row = await prisma.reader_worker_jobs.update({
        where: { jobId },
        data: {
          status: canRetry ? this.statuses.queued : this.statuses.failed,
          error: String(errorMessage || "Reader worker job failed").slice(
            0,
            1000
          ),
          runAfter: canRetry
            ? new Date(Date.now() + retryDelayMs)
            : job.runAfter,
          completedAt: canRetry ? null : new Date(),
          lockedBy: null,
          lockedAt: null,
          updatedAt: new Date(),
        },
      });
      return publicJob(row);
    } catch (error) {
      throwModelDataAccessError("readerWorkerJob.fail", error);
    }
  },

  async cancel(clause = {}) {
    try {
      const result = await prisma.reader_worker_jobs.updateMany({
        where: {
          ...clause,
          status: { in: [this.statuses.queued, this.statuses.running] },
        },
        data: {
          status: this.statuses.cancelled,
          completedAt: new Date(),
          lockedBy: null,
          lockedAt: null,
          updatedAt: new Date(),
        },
      });
      return result.count;
    } catch (error) {
      throwModelDataAccessError("readerWorkerJob.cancel", error);
    }
  },

  async snapshot({ recentLimit = 20 } = {}) {
    try {
      const [byStatus, byTask, recent] = await Promise.all([
        prisma.reader_worker_jobs.groupBy({
          by: ["status"],
          _count: { _all: true },
        }),
        prisma.reader_worker_jobs.groupBy({
          by: ["task"],
          _count: { _all: true },
        }),
        prisma.reader_worker_jobs.findMany({
          orderBy: { updatedAt: "desc" },
          take: Number(recentLimit || 20),
        }),
      ]);
      return {
        enabled: this.enabled(),
        byStatus: Object.fromEntries(
          byStatus.map((row) => [row.status, row._count._all])
        ),
        byTask: Object.fromEntries(
          byTask.map((row) => [row.task, row._count._all])
        ),
        recent: recent.map(publicJob),
      };
    } catch (error) {
      return {
        enabled: this.enabled(),
        error: error.message,
        byStatus: {},
        byTask: {},
        recent: [],
      };
    }
  },
};

module.exports = { ReaderWorkerJob };
