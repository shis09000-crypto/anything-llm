#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const {
  applyCftcAvailabilityRepairs,
  planCftcAvailabilityRepairs,
} = require("../utils/goldAnalysis/cftcAvailabilityRepair");
const { goldAnalysisRoot } = require("../utils/goldAnalysis/constants");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function compactCandidate(candidate) {
  return {
    reportDate: candidate.reportDate,
    oldAvailableAt: new Date(candidate.oldAvailableAtMs).toISOString(),
    newAvailableAt: new Date(candidate.newAvailableAtMs).toISOString(),
    shiftDays:
      Math.round((candidate.timestampShiftMs / 86_400_000) * 1_000) / 1_000,
    availabilityQuality: candidate.release.availabilityQuality,
    reason: candidate.release.reason,
  };
}

async function main() {
  const requestedApply = process.argv.includes("--apply");
  const execute = process.argv.includes("--execute");
  const environment = argValue("--env");
  const apply =
    requestedApply &&
    execute &&
    ["development", "production"].includes(environment);
  const databasePath = path.resolve(
    argValue("--db") || path.join(goldAnalysisRoot(), "gold-analysis.db")
  );
  if (!fs.existsSync(databasePath))
    throw new Error("gold_analysis_database_not_found");
  const db = new Database(databasePath, {
    readonly: !apply,
    fileMustExist: true,
  });
  db.pragma("busy_timeout = 5000");
  const plan = planCftcAvailabilityRepairs(db);
  let backupPath = null;
  let applied = null;
  if (apply) {
    backupPath = path.resolve(
      argValue("--backup") ||
        `${databasePath}.pre-cftc-release-repair-${Date.now()}.bak`
    );
    await db.backup(backupPath);
    applied = applyCftcAvailabilityRepairs(db, plan.candidates);
  }
  const remaining = apply ? planCftcAvailabilityRepairs(db) : null;
  db.close();
  const output = {
    success: !apply || remaining.changed === 0,
    mode: apply ? "apply" : "dry-run",
    requestedApply,
    execute,
    environment: environment || null,
    databasePath,
    backupPath,
    summary: {
      scanned: plan.scanned,
      changed: plan.changed,
      timestampShifted: plan.timestampShifted,
      futureLeakCorrections: plan.futureLeakCorrections,
      exact: plan.exact,
      officialSchedule: plan.officialSchedule,
      estimated: plan.estimated,
      maxDelayCorrectionDays:
        Math.round((plan.maxDelayCorrectionMs / 86_400_000) * 1_000) / 1_000,
    },
    shiftedRows: plan.candidates
      .filter((candidate) => candidate.timestampShiftMs !== 0)
      .map(compactCandidate),
    applied,
    remainingChanges: remaining?.changed ?? plan.changed,
    instruction:
      requestedApply && !apply
        ? "Apply requires --apply --execute and --env development|production."
        : !apply
          ? "Repeat with --apply --execute --env development|production to mutate."
          : null,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.success) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      success: false,
      error: error?.code || error?.message || "gold_cftc_repair_failed",
    })}\n`
  );
  process.exitCode = 1;
});
