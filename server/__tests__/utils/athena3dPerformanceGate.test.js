const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const {
  compilePerformancePlan,
  PerformancePackRegistry,
} = require("../../utils/characterPerformance");
const {
  PROFILE,
  resolvePerformanceSequence,
} = require("../../utils/responsesRuntime/character").v2;
const {
  ThreeDContextCache,
  hash,
} = require("../../utils/modelGateway/threeDContextCache");

const fixtureRoot = path.join(
  __dirname,
  "../../../docs/examples/character-responses/v2"
);

function ref(cursor = "a", revision = 0) {
  return {
    cursor_id: `chr_ctx_${cursor.repeat(32)}`,
    memory_revision: revision,
    state_revision: revision,
    checkpoint_revision: 0,
    last_turn_ordinal: revision,
    expires_at: Date.now() + 900_000,
  };
}

function p95(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1];
}

describe("Athena 3D Center deterministic performance gate", () => {
  test("Gateway hot-slot completion preparation stays below 25ms p95", () => {
    const cache = new ThreeDContextCache();
    const initial = ref();
    cache.install({
      session_id: "athena_perf_gate",
      context_ref: initial,
      stable_instructions: "json schema and protocol",
      context_prefix: "readonly context",
      template_hash: hash("json schema and protocol"),
      memory_point: {
        dialogue_memory: { checkpoint: null, turns: [] },
        performance_state_memory: { state_revision: 0 },
      },
      status: "active",
    });
    for (let index = 0; index < 50; index += 1)
      cache.completionInput({
        context_ref: initial,
        input: [{ type: "message", role: "user", content: "测试" }],
      });
    const samples = [];
    for (let index = 0; index < 500; index += 1) {
      const startedAt = performance.now();
      cache.completionInput({
        context_ref: initial,
        input: [{ type: "message", role: "user", content: `测试${index}` }],
      });
      samples.push(performance.now() - startedAt);
    }
    expect(p95(samples)).toBeLessThanOrEqual(25);
  });

  test("full 13-track plan compilation stays below 50ms p95", () => {
    const response = JSON.parse(
      fs.readFileSync(
        path.join(fixtureRoot, "01-apology-demand-response.json"),
        "utf8"
      )
    );
    const resolution = resolvePerformanceSequence(response, PROFILE.manifest);
    const pack = new PerformancePackRegistry().load().list()[0];
    const samples = [];
    for (let index = 0; index < 250; index += 1) {
      const startedAt = performance.now();
      compilePerformancePlan({
        session: { id: "chr_perf_benchmark" },
        response,
        resolution: resolution.event,
        pack,
        now: index,
      });
      samples.push(performance.now() - startedAt);
    }
    expect(p95(samples)).toBeLessThanOrEqual(50);
  });
});
