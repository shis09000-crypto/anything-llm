#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ROOT, writeReport } = require("./athena-3d-test-lib.cjs");

const DETERMINISTIC_TESTS = [
  "server/__tests__/endpoints/athena3dCenter.test.js",
  "server/__tests__/utils/athena3dCenterComprehensive.test.js",
  "server/__tests__/utils/athena3dPerformanceGate.test.js",
  "server/__tests__/utils/characterConversationContract.test.js",
  "server/__tests__/utils/characterConversationRuntime.test.js",
  "server/__tests__/utils/characterFlashAdapter.test.js",
  "server/__tests__/utils/characterPerformanceRuntime.test.js",
  "server/__tests__/utils/characterResponsesContract.test.js",
  "server/__tests__/utils/characterV2Contract.test.js",
  "server/__tests__/utils/threeDCharacterMemoryV2.test.js",
  "server/__tests__/utils/threeDCharacterMemoryV2PolicyMatrix.test.js",
  "server/__tests__/utils/threeDContextCache.test.js",
  "server/__tests__/utils/threeDContextCursor.test.js",
  "server/__tests__/utils/threeDLongTermMemoryContract.test.js",
];

const COMMANDS = {
  contracts: ["python3", ["scripts/validate-character-responses-contract.py"]],
  unit: ["npx", ["jest", "--runInBand", ...DETERMINISTIC_TESTS]],
  coverage: [
    "npx",
    [
      "jest",
      "--runInBand",
      "--coverage",
      "--coverageReporters=json-summary",
      "--coverageReporters=text-summary",
      "--coverageDirectory=reports/athena-3d-center/coverage",
      "--collectCoverageFrom=server/utils/chats/threeDSessionMemory/formationPolicy.js",
      "--collectCoverageFrom=server/utils/responsesRuntime/character/v2/presentationCompiler.js",
      ...DETERMINISTIC_TESTS,
    ],
  ],
  sqlite: ["node", ["server/scripts/athena-3d-sqlite-gate.js"]],
  sqlite_memory: [
    "node",
    ["server/scripts/athena-3d-sqlite-memory-integration.js"],
  ],
  postgres: ["node", ["server/scripts/athena-3d-postgres-gate.js"]],
  performance: ["node", ["server/scripts/athena-3d-performance-gate.js"]],
  stress: ["node", ["--expose-gc", "server/scripts/athena-3d-stress-gate.js"]],
  live: ["node", ["server/scripts/athena-3d-live-gateway-test.js"]],
  live_release: [
    "node",
    ["server/scripts/athena-3d-live-gateway-test.js", "--release"],
  ],
  e2e: ["node", ["server/scripts/athena-3d-playwright-gate.js"]],
  manual: ["node", ["server/scripts/athena-3d-manual-acceptance-gate.js"]],
};

const TIERS = {
  unit: ["contracts", "unit"],
  sqlite: ["contracts", "unit", "sqlite", "sqlite_memory"],
  postgres: ["postgres"],
  e2e: ["e2e"],
  live: ["live"],
  pr: ["contracts", "unit", "sqlite", "sqlite_memory", "performance", "e2e"],
  nightly: [
    "contracts",
    "unit",
    "sqlite",
    "sqlite_memory",
    "postgres",
    "performance",
    "stress",
    "live",
  ],
  release: [
    "contracts",
    "coverage",
    "sqlite",
    "sqlite_memory",
    "postgres",
    "performance",
    "stress",
    "live_release",
    "e2e",
    "manual",
  ],
};

function runStep(name) {
  const [command, args] = COMMANDS[name];
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  return {
    name,
    status: result.status === 0 ? "passed" : "failed",
    exit_code: result.status ?? 1,
    duration_ms: Date.now() - startedAt,
    signal: result.signal || null,
  };
}

function coverageGate() {
  const location = path.join(
    ROOT,
    "reports/athena-3d-center/coverage/coverage-summary.json"
  );
  if (!fs.existsSync(location))
    return { status: "failed", reason: "coverage_summary_missing" };
  const summary = JSON.parse(fs.readFileSync(location, "utf8"));
  return {
    status:
      summary.total.lines.pct >= 90 && summary.total.branches.pct >= 85
        ? "passed"
        : "failed",
    lines: summary.total.lines,
    branches: summary.total.branches,
    thresholds: { lines: 90, branches: 85 },
  };
}

function main() {
  const tier = String(process.argv[2] || "unit");
  const steps = TIERS[tier];
  if (!steps) {
    console.error(`Unknown Athena 3D test tier: ${tier}`);
    process.exitCode = 2;
    return;
  }
  const results = [];
  for (const step of steps) {
    const result = runStep(step);
    results.push(result);
    if (result.status === "failed") break;
  }
  const coverage = steps.includes("coverage") ? coverageGate() : null;
  const failed =
    results.some((result) => result.status === "failed") ||
    coverage?.status === "failed";
  const { destination, report } = writeReport(`${tier}-gate`, {
    suite: tier,
    status: failed ? "failed" : "passed",
    fail_fast: true,
    critical_suites_skippable: false,
    results,
    coverage,
  });
  console.log(JSON.stringify({ report: destination, ...report }, null, 2));
  if (failed) process.exitCode = 1;
}

main();
