const crypto = require("crypto");
const { compactConversationMemory } = require("./modelClient");
const {
  consolidateLongTermMemory,
  finalizeFromHotContext,
} = require("./longTermModelClient");
const { memoryConfig } = require("./config");
const { ThreeDSessionMemoryRepository, memoryError } = require("./repository");
const { indexPending } = require("./characterMemoryVectorIndex");

class ThreeDSessionMemoryRuntime {
  constructor({ repository = null, env = process.env } = {}) {
    this.env = env;
    this.config = memoryConfig(env);
    this.repository = repository || new ThreeDSessionMemoryRepository({ env });
    this.ownerId = `chat-runtime:${process.pid}:${crypto.randomUUID()}`;
    this.timer = null;
    this.running = false;
    this.lastMaintenanceAt = null;
    this.lastError = null;
  }

  snapshot() {
    return {
      ready: true,
      enabled: this.config.enabled,
      storageMode: "plaintext_json",
      keyCustodyOnHotPath: false,
      workerRunning: Boolean(this.timer),
      maintenanceActive: this.running,
      lastMaintenanceAt: this.lastMaintenanceAt,
      lastError: this.lastError,
    };
  }

  start() {
    if (!this.config.enabled || this.timer) return;
    this.timer = setInterval(
      () => void this.maintain({ limit: 1 }),
      this.config.maintenanceIntervalMs
    );
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async maintain({ limit = 1 } = {}) {
    if (!this.config.enabled)
      return { enabled: false, inspected: 0, completed: 0, failed: 0 };
    if (this.running)
      return {
        enabled: true,
        busy: true,
        inspected: 0,
        completed: 0,
        failed: 0,
      };
    this.running = true;
    const result = { enabled: true, inspected: 0, completed: 0, failed: 0 };
    try {
      const legacyReplay = await this.repository.enqueueLegacyReflectionJob();
      if (legacyReplay) result.legacy_replay_queued = legacyReplay.id;
      for (
        let index = 0;
        index < Math.max(1, Math.min(Number(limit) || 1, 10));
        index += 1
      ) {
        const job = await this.repository.claimCheckpoint(this.ownerId);
        if (!job) break;
        result.inspected += 1;
        try {
          const source = await this.repository.checkpointSource(job);
          const compacted = await compactConversationMemory(
            {
              ...source,
              maxOutputTokens: this.config.checkpointMaxTokens,
            },
            this.env
          );
          const completed = await this.repository.completeCheckpoint(
            job,
            compacted
          );
          if (completed.applied) result.completed += 1;
        } catch (error) {
          result.failed += 1;
          this.lastError = String(
            error?.code || error?.message || "compaction_failed"
          );
          await this.repository.failCheckpoint(job, error);
        }
      }
      for (
        let index = 0;
        index < Math.max(1, Math.min(Number(limit) || 1, 10));
        index += 1
      ) {
        const job = await this.repository.claimLongTermJob(this.ownerId);
        if (!job) break;
        result.inspected += 1;
        try {
          const source = await this.repository.longTermJobSource(job);
          const consolidated = await consolidateLongTermMemory(
            source.source,
            this.env
          );
          await this.repository.completeLongTermJob(job, {
            ...consolidated,
            cacheMode: "durable_rebuild",
          });
          result.completed += 1;
        } catch (error) {
          result.failed += 1;
          this.lastError = String(
            error?.code || error?.message || "long_term_memory_failed"
          );
          await this.repository.failLongTermJob(job, error);
        }
      }
      const indexed = await indexPending(this.repository.client, {
        limit: Math.max(1, Math.min(Number(limit) || 1, 16)),
      }).catch((error) => {
        this.lastError = String(error?.message || error);
        return { inspected: 0, indexed: 0, failed: 1 };
      });
      result.vector_index = indexed;
      this.lastMaintenanceAt = new Date().toISOString();
      return result;
    } finally {
      this.running = false;
    }
  }

  createSession(input) {
    if (!this.config.enabled)
      throw memoryError("athena_3d_memory_disabled", 503);
    return this.repository.createSession(input);
  }

  contextResolve(input) {
    if (!this.config.enabled)
      throw memoryError("athena_3d_memory_disabled", 503);
    return this.repository.contextResolve(input);
  }

  contextPrepare(input) {
    if (!this.config.enabled)
      throw memoryError("athena_3d_memory_disabled", 503);
    return this.repository.contextPrepare(input);
  }

  freezeLongTermRecall(input) {
    if (!this.config.enabled)
      throw memoryError("athena_3d_memory_disabled", 503);
    return this.repository.freezeLongTermRecall(input);
  }

  commitTurn(input) {
    if (!this.config.enabled)
      throw memoryError("athena_3d_memory_disabled", 503);
    return this.repository.commitTurn(input);
  }

  status(input) {
    return this.repository.status(input);
  }

  deleteSession(input) {
    return this.repository.deleteSession(input);
  }

  archiveLongTerm(input) {
    if (!this.config.enabled)
      throw memoryError("athena_3d_memory_disabled", 503);
    return this.repository.archiveLongTerm(input).then((archive) => {
      if (archive?.job?.id && archive.job.status !== "completed")
        setImmediate(
          () => void this.finalizeArchivedJob(archive.job.id, input.contextRef)
        );
      return { ...archive, finalization_async: true };
    });
  }

  async finalizeArchivedJob(jobId, contextRef) {
    let job = null;
    try {
      job = await this.repository.claimLongTermJobById(
        jobId,
        `${this.ownerId}:hot`
      );
      if (!job) return { skipped: true };
      const source = await this.repository.longTermJobSource(job);
      const result = await finalizeFromHotContext(
        { contextRef, source: source.source },
        this.env
      );
      const completed = await this.repository.completeLongTermJob(job, result);
      return { finalized: true, ...completed };
    } catch (error) {
      if (job) await this.repository.failLongTermJob(job, error);
      this.lastError = String(
        error.code || error.message || "long_term_memory_failed"
      );
      return {
        finalized: false,
        queued: true,
        error: error.code || error.message,
      };
    }
  }

  async finalizeLongTerm(input) {
    return this.archiveLongTerm(input);
  }

  longTermContext(input) {
    return this.repository.resolveLongTermContext(input);
  }

  longTermStatus(input) {
    return this.repository.longTermStatus(input);
  }

  listLongTermObjects(input) {
    return this.repository.listLongTermObjects(input);
  }

  deleteLongTermSession(input) {
    return this.repository.deleteLongTermSession(input);
  }

  resetLongTermProfile(input) {
    return this.repository.resetLongTermProfile(input);
  }

  reconsolidateLongTerm(input) {
    return this.repository.reconsolidateLongTerm(input);
  }
}

module.exports = { ThreeDSessionMemoryRuntime };
