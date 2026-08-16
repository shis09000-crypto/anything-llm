#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const {
  measure,
  metric,
  writeReport,
} = require("../../scripts/athena-3d-test-lib.cjs");
const {
  compilePerformancePlan,
  PerformancePackRegistry,
} = require("../utils/characterPerformance");
const {
  PROFILE,
  resolvePerformanceSequence,
} = require("../utils/responsesRuntime/character").v2;
const {
  ThreeDContextCache,
  hash,
} = require("../utils/modelGateway/threeDContextCache");

function ref() {
  return {
    cursor_id: `chr_ctx_${"a".repeat(32)}`,
    memory_revision: 0,
    state_revision: 0,
    checkpoint_revision: 0,
    last_turn_ordinal: 0,
    expires_at: Date.now() + 900_000,
  };
}

async function main() {
  const response = JSON.parse(
    fs.readFileSync(
      path.join(
        __dirname,
        "../../docs/examples/character-responses/v2/01-apology-demand-response.json"
      ),
      "utf8"
    )
  );
  const resolution = resolvePerformanceSequence(response, PROFILE.manifest);
  const pack = new PerformancePackRegistry().load().list()[0];
  const contextRef = ref();
  const cache = new ThreeDContextCache();
  cache.install({
    session_id: "athena_3d_performance_gate",
    context_ref: contextRef,
    stable_instructions: "json schema and protocol",
    context_prefix: "readonly context",
    template_hash: hash("json schema and protocol"),
    memory_point: {
      dialogue_memory: { checkpoint: null, turns: [] },
      performance_state_memory: { state_revision: 0 },
    },
    status: "active",
  });
  const gateway = await measure(1_000, (index) => {
    cache.completionInput({
      context_ref: contextRef,
      input: [{ type: "message", role: "user", content: `测试${index}` }],
    });
  });
  const compile = await measure(500, (index) => {
    compilePerformancePlan({
      session: { id: "chr_perf_benchmark" },
      response,
      resolution: resolution.event,
      pack,
      now: index,
    });
  });
  const samples = {
    gateway_hot_slot: metric(gateway, 25),
    full_13_track_compile: metric(compile, 50),
  };
  const failed = Object.entries(samples)
    .filter(([, value]) => !value.passed)
    .map(([name]) => name);
  const { destination, report } = writeReport("performance-gate", {
    suite: "performance",
    status: failed.length ? "failed" : "passed",
    thresholds: {
      gateway_hot_slot_p95_ms: 25,
      full_13_track_compile_p95_ms: 50,
    },
    metrics: samples,
    process_memory: process.memoryUsage(),
    monotonic_clock: performance.timeOrigin,
    failures: failed,
  });
  console.log(JSON.stringify({ report: destination, ...report }, null, 2));
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
