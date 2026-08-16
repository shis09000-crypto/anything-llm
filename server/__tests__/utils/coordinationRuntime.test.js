/* eslint-env jest */

const { DataCoordinationCenter } = require("../../utils/coordination/centers");
const { CoordinationRuntime } = require("../../utils/coordination/runtime");
const {
  loadManifests,
} = require("../../utils/modulePlatform/manifestRegistry");

function memoryRepository() {
  const runs = new Map();
  const steps = new Map();
  const receipts = new Map();
  const instances = new Map();
  const lifecycle = new Map();
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const runWithSteps = (run) => ({
    ...clone(run),
    steps: [...steps.values()]
      .filter((step) => step.runId === run.id)
      .map(clone),
  });
  return {
    runs,
    receipts,
    instances,
    lifecycle,
    async createRun(data) {
      if (data.idempotencyKey) {
        const existing = [...runs.values()].find(
          (run) => run.idempotencyKey === data.idempotencyKey
        );
        if (existing) return runWithSteps(existing);
      }
      runs.set(data.id, { ...clone(data), evidence: [], escalationLevel: 0 });
      return runWithSteps(runs.get(data.id));
    },
    async getRun(id) {
      return runs.has(id) ? runWithSteps(runs.get(id)) : null;
    },
    async transitionRun({ id, from, to, data = {} }) {
      const current = runs.get(id);
      if (!current || !from.includes(current.status))
        throw new Error("coordination_run_state_conflict");
      runs.set(id, { ...current, ...clone(data), status: to });
      return runWithSteps(runs.get(id));
    },
    async addStep(data) {
      const key = `${data.runId}:${data.moduleId}:${data.capability}`;
      if (!steps.has(key)) steps.set(key, clone(data));
      return clone(steps.get(key));
    },
    async createOptimisticReceipt(data) {
      if (!receipts.has(data.mutationId))
        receipts.set(data.mutationId, clone(data));
      return clone(receipts.get(data.mutationId));
    },
    async upsertModuleHeartbeat(data) {
      instances.set(data.instanceId, clone(data));
      return clone(data);
    },
    async appendLifecycleEvent(data) {
      if (lifecycle.has(data.eventId)) return null;
      lifecycle.set(data.eventId, clone(data));
      return clone(data);
    },
    async listModuleInstances() {
      return [...instances.values()].map(clone);
    },
  };
}

describe("CoordinationRuntime", () => {
  test("keeps all five centers shadow-only by default and is idempotent", async () => {
    const repository = memoryRepository();
    const runtime = new CoordinationRuntime({
      repository,
      env: {},
      emit: jest.fn(),
    });
    await runtime.start();
    const input = {
      center: "task",
      type: "test.workflow",
      idempotencyKey: "same-plan",
      steps: [
        {
          id: "reader-self-test",
          moduleId: "reader-worker",
          capability: "module.self-test",
        },
      ],
    };
    const first = await runtime.plan(input);
    const second = await runtime.plan(input);
    expect(first.id).toBe(second.id);
    expect(first).toMatchObject({
      center: "task",
      status: "shadow",
      steps: [
        expect.objectContaining({
          moduleId: "reader-worker",
          capability: "module.self-test",
        }),
      ],
    });
    expect(repository.runs).toHaveProperty("size", 1);
  });

  test("denies cross-schema writes before a coordination run exists", () => {
    const center = new DataCoordinationCenter();
    const [schema, owner] = center.owners.entries().next().value;
    expect(() =>
      center.plan({
        schema,
        operation: "write",
        moduleId: owner === "athena-api" ? "chat-runtime" : "athena-api",
        capability: "module.self-test",
      })
    ).toThrow("coordination_cross_schema_write_denied");
  });

  test("persists only hashes for optimistic state", async () => {
    const repository = memoryRepository();
    const runtime = new CoordinationRuntime({
      repository,
      env: {},
      emit: jest.fn(),
    });
    await runtime.start();
    await runtime.plan({
      center: "optimistic",
      mutationId: "mutation-1",
      resourceType: "workspace-thread",
      resourceId: "thread-1",
      patchHash: "a".repeat(64),
      steps: [
        {
          moduleId: "sync-v2",
          capability: "module.self-test",
        },
      ],
    });
    const receipt = repository.receipts.get("mutation-1");
    expect(receipt).toMatchObject({
      patchHash: "a".repeat(64),
      resourceId: "thread-1",
    });
    expect(receipt).not.toHaveProperty("patch");
    expect(receipt).not.toHaveProperty("value");
  });

  test("cannot escalate before lower autonomy is exhausted", async () => {
    const repository = memoryRepository();
    const runtime = new CoordinationRuntime({
      repository,
      env: { ATHENA_COORDINATION_AUTHORITY_MODE: "authoritative" },
      emit: jest.fn(),
    });
    await runtime.start();
    const run = await runtime.plan({
      center: "recovery",
      reasonCode: "reader_unavailable",
      steps: [
        {
          moduleId: "reader-worker",
          capability: "module.self-test",
        },
      ],
    });
    await runtime.startRun(run.id);
    await runtime.requestEscalation({
      runId: run.id,
      targetLevel: 1,
      moduleId: "reader-worker",
    });
    await expect(
      runtime.requestEscalation({
        runId: run.id,
        targetLevel: 2,
        moduleId: "reader-worker",
      })
    ).rejects.toMatchObject({ code: "self_heal_not_exhausted" });

    await runtime.recordAutonomyAttempt(run.id, {
      level: 1,
      status: "exhausted",
      validation: "failed",
      reasonCode: "retry_budget_exhausted",
      evidenceRef: "trace:l1",
    });
    const isolated = await runtime.requestEscalation({
      runId: run.id,
      targetLevel: 2,
      moduleId: "reader-worker",
    });
    expect(isolated.run).toMatchObject({
      escalationLevel: 2,
      status: "recovering",
    });
    await runtime.recordAutonomyAttempt(run.id, {
      level: 2,
      status: "exhausted",
      validation: "failed",
      reasonCode: "isolation_validation_failed",
      evidenceRef: "trace:l2",
    });
    await expect(
      runtime.requestEscalation({
        runId: run.id,
        targetLevel: 3,
        phase: "execute",
        approvalCount: 0,
        moduleId: "reader-worker",
      })
    ).rejects.toMatchObject({ code: "operations_approval_required" });
  });

  test("reports complete module coverage only for fresh ready leases", async () => {
    const repository = memoryRepository();
    const runtime = new CoordinationRuntime({
      repository,
      env: {},
      emit: jest.fn(),
    });
    const now = Date.parse("2026-08-01T12:00:00.000Z");
    const manifestIds = loadManifests().map((manifest) => manifest.id);
    for (const moduleId of manifestIds) {
      await repository.upsertModuleHeartbeat({
        instanceId: `${moduleId}:instance`,
        moduleId,
        runtimeRole: moduleId,
        version: "2.5.0",
        manifestFingerprint: "f".repeat(64),
        state: "ready",
        heartbeatAt: new Date(now - 1_000).toISOString(),
        leaseExpiresAt: new Date(now + 30_000).toISOString(),
      });
    }

    await expect(runtime.moduleCoverage({ now })).resolves.toMatchObject({
      expected: 23,
      healthy: 23,
      complete: true,
      unknown: [],
      degraded: [],
    });

    const stale = repository.instances.get("reader-worker:instance");
    stale.leaseExpiresAt = new Date(now - 1).toISOString();
    repository.instances.set("reader-worker:instance", stale);
    repository.instances.set("unknown:instance", {
      ...stale,
      instanceId: "unknown:instance",
      moduleId: "unknown-module",
    });
    const coverage = await runtime.moduleCoverage({ now });
    expect(coverage).toMatchObject({
      expected: 23,
      healthy: 22,
      complete: false,
      unknown: ["unknown-module"],
      degraded: ["reader-worker"],
    });
  });
});
