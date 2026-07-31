/* eslint-env jest */

const {
  InfrastructureHealthMonitor,
  normalizedProbeState,
} = require("../../utils/operations/infrastructureHealthMonitor");
const {
  operationsDependencyProbe,
  postQuantumProbeFactory,
  remoteDependencyProbe,
} = require("../../utils/operations/infrastructureProbes");

const services = () => [
  {
    id: "main-database",
    kind: "data-store",
    criticality: "critical",
  },
  {
    id: "object-storage",
    kind: "data-store",
    criticality: "high",
  },
];

describe("Operations infrastructure health monitor", () => {
  test("requires an explicit ready contract", () => {
    expect(normalizedProbeState({}, 2)).toMatchObject({
      status: "degraded",
      ready: false,
      reasonCode: "infrastructure_reported_not_ready",
    });
    expect(normalizedProbeState({ ready: true }, 2)).toMatchObject({
      status: "healthy",
      ready: true,
    });
  });

  test("projects authoritative probes and emits metadata-only transitions", async () => {
    const emit = jest.fn();
    const database = jest.fn().mockResolvedValue({ ready: true });
    const objectStorage = jest.fn().mockResolvedValue({ ready: true });
    const monitor = new InfrastructureHealthMonitor({
      emit,
      services,
      env: { ATHENA_OPERATIONS_INFRA_POLL_MS: "60000" },
    });
    monitor.start({
      providers: {
        "main-database": database,
        "object-storage": objectStorage,
      },
    });
    const healthy = await monitor.refresh();
    expect(healthy.summary).toMatchObject({
      total: 2,
      healthy: 2,
      degraded: 0,
      unmonitored: 0,
      complete: true,
    });

    objectStorage.mockRejectedValueOnce(
      Object.assign(new Error("bucket unavailable"), {
        code: "S3_UNAVAILABLE",
      })
    );
    const degraded = await monitor.refresh();
    expect(
      degraded.components.find(
        (component) => component.componentId === "object-storage"
      )
    ).toMatchObject({
      status: "degraded",
      ready: false,
      reasonCode: "S3_UNAVAILABLE",
    });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "infrastructure.health.changed",
        category: "infrastructure_health",
        sensitivity: "metadata_only",
        subject: expect.objectContaining({ component: "object-storage" }),
      })
    );
    await monitor.stop();
  });

  test("marks missing infrastructure probes as unmonitored", async () => {
    const monitor = new InfrastructureHealthMonitor({
      services,
      emit: jest.fn(),
    });
    monitor.start({
      providers: {
        "main-database": async () => ({ ready: true }),
      },
    });
    const snapshot = await monitor.refresh();
    expect(snapshot.summary).toMatchObject({
      healthy: 1,
      unmonitored: 1,
      complete: false,
    });
    await monitor.stop();
  });

  test("normalizes operations and remote dependency health", async () => {
    expect(
      operationsDependencyProbe(
        {
          health: () => ({
            jetstream: { connected: true },
          }),
        },
        "jetstream"
      )
    ).toEqual({ ready: true, reasonCode: null });

    const request = jest.fn().mockResolvedValue({
      dependencies: {
        modelProvider: { ready: true },
      },
    });
    await expect(
      remoteDependencyProbe({
        env: {},
        request,
        baseUrl: "https://model:3018",
        path: "/internal/v1/models/health",
        selector: (response) => response.dependencies.modelProvider,
      })
    ).resolves.toEqual({ ready: true, reasonCode: null });
  });

  test("does not downgrade required post-quantum capabilities", async () => {
    const probe = postQuantumProbeFactory({
      ATHENA_PQ_RUNTIME_EXPECTED_CAPABILITIES:
        "classical_provider_baseline",
    });
    await expect(probe()).resolves.toMatchObject({ ready: true });
  });
});
