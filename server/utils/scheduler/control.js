const crypto = require("crypto");
const { BackgroundService } = require("../BackgroundWorkers");
const {
  distributedTopology,
  requestInternalService,
} = require("../microModules");

function schedulerInternalUrl(env = process.env) {
  return String(
    env.ATHENA_SCHEDULER_INTERNAL_URL || "https://scheduler:3014"
  ).replace(/\/+$/, "");
}

class LocalSchedulerControl {
  constructor(service = new BackgroundService()) {
    this.service = service;
  }

  async addScheduledJob(job) {
    this.service.addScheduledJob(job);
    return { synced: true, jobId: Number(job.id) };
  }

  async syncScheduledJob(jobId) {
    await this.service.syncScheduledJob(jobId);
    return { synced: true, jobId: Number(jobId) };
  }

  async removeScheduledJob(jobId) {
    this.service.removeScheduledJob(jobId);
    return { removed: true, jobId: Number(jobId) };
  }

  async killRun(jobId, runId) {
    return { killed: this.service.killRun(jobId, runId) };
  }

  async enqueueScheduledJob(jobId, { idempotencyKey = null } = {}) {
    return this.service.enqueueScheduledJob(jobId, { idempotencyKey });
  }
}

class RemoteSchedulerControl {
  constructor({ env = process.env } = {}) {
    this.env = env;
    this.baseUrl = schedulerInternalUrl(env);
  }

  request(path, options = {}) {
    return requestInternalService({
      callerRole: "athena-api",
      url: `${this.baseUrl}${path}`,
      env: this.env,
      ...options,
    });
  }

  addScheduledJob(job) {
    return this.syncScheduledJob(job.id);
  }

  syncScheduledJob(jobId) {
    return this.request(`/internal/v1/scheduler/jobs/${Number(jobId)}/sync`, {
      idempotencyKey: `scheduler-sync:${Number(jobId)}`,
    });
  }

  removeScheduledJob(jobId) {
    return this.request(`/internal/v1/scheduler/jobs/${Number(jobId)}`, {
      method: "DELETE",
      idempotencyKey: `scheduler-remove:${Number(jobId)}`,
    });
  }

  killRun(jobId, runId) {
    return this.request(
      `/internal/v1/scheduler/jobs/${Number(jobId)}/runs/${Number(runId)}/kill`,
      { idempotencyKey: `scheduler-kill:${Number(runId)}` }
    );
  }

  async enqueueScheduledJob(jobId, { idempotencyKey = null } = {}) {
    const stableKey = idempotencyKey || crypto.randomUUID();
    const result = await this.request(
      `/internal/v1/scheduler/jobs/${Number(jobId)}/trigger`,
      { idempotencyKey: stableKey }
    );
    return result.run
      ? {
          ...result.run,
          idempotentReplay: result.idempotentReplay,
        }
      : null;
  }
}

function schedulerControl(env = process.env) {
  if (
    distributedTopology(env) &&
    String(env.ATHENA_SCHEDULER_REMOTE || "true") !== "false"
  )
    return new RemoteSchedulerControl({ env });
  return new LocalSchedulerControl();
}

module.exports = {
  LocalSchedulerControl,
  RemoteSchedulerControl,
  schedulerControl,
  schedulerInternalUrl,
};
