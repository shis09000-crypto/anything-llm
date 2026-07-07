#!/usr/bin/env node

const path = require("path");

const {
  assertMigrationCompliance,
  scanScriptAccess,
  scanBypassAccess,
  writeBypassBaseline,
} = require("../utils/dataAccess/dataAccessMigrationGuard");

function printUsage() {
  console.log(`Usage:
  node scripts/data-access-bypass-check.js [--update-baseline]
  node scripts/data-access-bypass-check.js --scripts-report [--unclassified-only]

Environment:
  DATA_ACCESS_MODE=observe|warn|enforce
  DATA_ACCESS_BASELINE_PATH=/optional/path/to/dataAccessBypassBaseline.json
  DATA_ACCESS_ENFORCE_FULL=true
`);
}

function summarize(audit) {
  const comparison = audit.baselineComparison || {};
  return {
    mode: audit.mode,
    scannedFiles: audit.scannedFiles,
    blocked: audit.blocked,
    baselineBlocked: comparison.baselineBlocked || 0,
    additions: comparison.additions?.length || 0,
    resolved: comparison.resolved?.length || 0,
    baselinePath: comparison.baselinePath
      ? path.relative(process.cwd(), comparison.baselinePath)
      : null,
  };
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    printUsage();
    return;
  }

  if (args.has("--scripts-report")) {
    const report = scanScriptAccess({
      includeClassified: !args.has("--unclassified-only"),
      limit: Infinity,
    });
    console.log(
      JSON.stringify(
        {
          ok: report.unclassified === 0,
          type: "scripts-report",
          scannedFiles: report.scannedFiles,
          findingsCount: report.findingsCount,
          classified: report.classified,
          unclassified: report.unclassified,
          byCategory: report.byCategory,
          byRisk: report.byRisk,
          byDomain: report.byDomain,
          findings: report.findings.map((finding) => ({
            file: finding.file,
            line: finding.line,
            type: finding.type,
            domain: finding.domain,
            category: finding.scriptCategory,
            risk: finding.scriptRisk,
            reason: finding.scriptReason,
            recommendedAction: finding.recommendedAction,
            classified: finding.scriptAllowed,
          })),
        },
        null,
        2
      )
    );
    if (report.unclassified > 0) process.exitCode = 1;
    return;
  }

  if (args.has("--update-baseline")) {
    const audit = scanBypassAccess({ limit: Infinity });
    const baseline = writeBypassBaseline({ audit });
    console.log(
      JSON.stringify(
        {
          ok: true,
          action: "updated-baseline",
          blocked: baseline.blocked,
          signatures: baseline.findings.length,
        },
        null,
        2
      )
    );
    return;
  }

  try {
    const audit = assertMigrationCompliance({ limit: Infinity });
    console.log(JSON.stringify({ ok: true, ...summarize(audit) }, null, 2));
  } catch (error) {
    const audit = error.audit || {};
    const additions = audit.baselineComparison?.additions || [];
    console.error(
      JSON.stringify(
        {
          ok: false,
          code: error.code || "DATA_ACCESS_CHECK_FAILED",
          message: error.message,
          ...summarize(audit),
          sampleAdditions: additions.slice(0, 10),
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  }
}

main();
