#!/usr/bin/env node

const {
  ThreeDContextCache,
  hash,
} = require("../utils/modelGateway/threeDContextCache");
const {
  metric,
  writeReport,
} = require("../../scripts/athena-3d-test-lib.cjs");
const { performance } = require("perf_hooks");

function ref(session, revision = 0) {
  const cursor = Buffer.from(`${session}:${revision}`)
    .toString("hex")
    .padEnd(32, "0")
    .slice(0, 32);
  return {
    cursor_id: `chr_ctx_${cursor}`,
    memory_revision: revision,
    state_revision: revision,
    checkpoint_revision: 0,
    last_turn_ordinal: revision,
    expires_at: Date.now() + 900_000,
  };
}

function install(cache, session) {
  const contextRef = ref(session);
  cache.install({
    session_id: session,
    context_ref: contextRef,
    stable_instructions: "json schema and protocol",
    context_prefix: "readonly context",
    template_hash: hash("json schema and protocol"),
    memory_point: {
      dialogue_memory: { checkpoint: null, turns: [] },
      performance_state_memory: { state_revision: 0, session },
    },
    status: "active",
  });
  return contextRef;
}

async function round(roundIndex, operationsPerSession) {
  const cache = new ThreeDContextCache({
    env: {
      ATHENA_3D_CONTEXT_CACHE_TTL_MS: "900000",
      ATHENA_3D_CONTEXT_CACHE_MAX_SLOTS: "16",
      ATHENA_3D_CONTEXT_CACHE_MAX_BYTES: "201326592",
      ATHENA_3D_CONTEXT_CACHE_SLOT_MAX_BYTES: "33554432",
    },
  });
  const sessions = Array.from({ length: 16 }, (_, index) => `stress_${roundIndex}_${index}`);
  const refs = new Map(sessions.map((session) => [session, install(cache, session)]));
  const samples = [];
  for (let index = 0; index < operationsPerSession; index += 1)
    for (const session of sessions) {
      const startedAt = performance.now();
      const prepared = cache.completionInput({
        context_ref: refs.get(session),
        input: [{ type: "message", role: "user", content: `${session}:${index}` }],
      });
      if (prepared.slot.memoryPoint.performance_state_memory.session !== session)
        throw new Error("cross_session_context_contamination");
      samples.push(performance.now() - startedAt);
    }
  const status = cache.status();
  if (status.slots !== 16) throw new Error("context_slot_count_invalid");
  if (typeof global.gc === "function") global.gc();
  return {
    metric: metric(samples, 25),
    status,
    heap: process.memoryUsage().heapUsed,
    rss: process.memoryUsage().rss,
  };
}

async function main() {
  const minutes = Number(process.env.ATHENA_3D_STRESS_MINUTES || 0);
  const deadline = minutes > 0 ? Date.now() + minutes * 60_000 : null;
  const rounds = [];
  let index = 0;
  do {
    rounds.push(await round(index, Number(process.env.ATHENA_3D_STRESS_OPERATIONS || 500)));
    index += 1;
  } while ((deadline && Date.now() < deadline) || (!deadline && index < 3));
  const steadyRounds = rounds.slice(Math.min(1, rounds.length - 1));
  const minimumSteadyHeap = Math.min(...steadyRounds.map((entry) => entry.heap));
  const maximumSteadyHeap = Math.max(...steadyRounds.map((entry) => entry.heap));
  const memoryGrowth = minimumSteadyHeap
    ? (maximumSteadyHeap - minimumSteadyHeap) / minimumSteadyHeap
    : 0;
  const checks = {
    three_round_minimum: rounds.length >= 3,
    p95_within_25ms: rounds.every((entry) => entry.metric.passed),
    no_cross_session_contamination: true,
    slots_bounded_to_16: rounds.every((entry) => entry.status.slots === 16),
    stable_heap_within_20_percent: memoryGrowth <= 0.2,
  };
  const status = Object.values(checks).every(Boolean) ? "passed" : "failed";
  const { destination, report } = writeReport("stress-gate", {
    suite: "stress",
    status,
    configured_minutes: minutes,
    checks,
    rounds,
    memory_growth_rate: Number(memoryGrowth.toFixed(6)),
  });
  console.log(JSON.stringify({ report: destination, ...report }, null, 2));
  if (status !== "passed") process.exitCode = 1;
}

main().catch((error) => {
  const { destination } = writeReport("stress-gate", {
    suite: "stress",
    status: "failed",
    error: { code: error.code || "ATHENA_3D_STRESS_FAILED", message: error.message },
  });
  console.error(`${error.stack || error.message}\nReport: ${destination}`);
  process.exitCode = 1;
});
