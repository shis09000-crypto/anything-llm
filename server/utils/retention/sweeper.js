const { DataAccessCenter } = require("../dataAccess");

const DAY_MS = 24 * 60 * 60 * 1_000;

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function retentionEnabled(env = process.env) {
  return (
    String(env.ATHENA_RETENTION_ENABLED || "false").toLowerCase() === "true"
  );
}

function retentionPolicy(env = process.env) {
  return {
    patrolDays: positiveInteger(env.ATHENA_PATROL_RETENTION_DAYS, 30, 3650),
    eventLogDays: positiveInteger(
      env.ATHENA_EVENT_LOG_RETENTION_DAYS,
      180,
      3650
    ),
    stagingHours: positiveInteger(
      env.ATHENA_CONTENT_STAGING_RETENTION_HOURS,
      24,
      720
    ),
    objectDeleteGraceDays: positiveInteger(
      env.ATHENA_CONTENT_DELETE_GRACE_DAYS,
      7,
      365
    ),
    batchSize: positiveInteger(env.ATHENA_RETENTION_BATCH_SIZE, 100, 1000),
  };
}

async function sweepPatrolRuns({ now, policy }) {
  return DataAccessCenter.retention.sweepPatrolRuns({
    cutoff: new Date(now.getTime() - policy.patrolDays * DAY_MS),
    deleteAfter: new Date(
      now.getTime() + policy.objectDeleteGraceDays * DAY_MS
    ),
    limit: policy.batchSize,
  });
}

async function sweepExpiredUploads({ now, policy }) {
  return DataAccessCenter.retention.sweepExpiredUploads({
    now,
    limit: policy.batchSize,
  });
}

async function sweepOperationalRows({ now, policy }) {
  const base = await DataAccessCenter.retention.sweepOperationalRows({
    eventLogCutoff: new Date(now.getTime() - policy.eventLogDays * DAY_MS),
    now,
  });
  const [syncOutbox, mutationReceipts] = await Promise.all([
    DataAccessCenter.syncV2.pruneExpired({ now }),
    DataAccessCenter.athenaMutationReceipt.pruneExpired({ now }),
  ]);
  return {
    ...base,
    syncOutbox: Number(syncOutbox.count || 0),
    mutationReceipts: Number(mutationReceipts.count || 0),
  };
}

async function runRetentionSweep({ now = new Date(), force = false } = {}) {
  if (!force && !retentionEnabled())
    return { skipped: true, reason: "disabled" };
  const policy = retentionPolicy();
  const patrol = await sweepPatrolRuns({ now, policy });
  const uploads = await sweepExpiredUploads({ now, policy });
  const operational = await sweepOperationalRows({ now, policy });
  const contentObjects = await DataAccessCenter.contentObject.reconcile({
    stagingBefore: new Date(
      now.getTime() - policy.stagingHours * 60 * 60 * 1_000
    ),
    deleteBefore: now,
    limit: policy.batchSize,
  });
  return {
    skipped: false,
    policy,
    patrol,
    uploads,
    operational,
    contentObjects,
  };
}

module.exports = {
  retentionEnabled,
  retentionPolicy,
  runRetentionSweep,
  sweepExpiredUploads,
  sweepPatrolRuns,
};
