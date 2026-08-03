/* eslint-env jest */

const {
  RemoteOperationsAccess,
  coordinationLifecycleHealth,
  coordinationRemoteMode,
  operationsRemoteMode,
  operationsShadowSnapshot,
} = require("../../utils/operations/access");

describe("Remote Operations access", () => {
  const env = {
    ATHENA_RUNTIME_TOPOLOGY: "distributed",
    ATHENA_RUNTIME_ROLE: "api",
    ATHENA_OPERATIONS_PLANE_INLINE: "false",
    ATHENA_OPERATIONS_INTERNAL_URL: "https://operations-plane:3015/",
  };

  test("activates only for a separately deployed Operations Plane", () => {
    expect(operationsRemoteMode(env)).toBe(true);
    expect(
      operationsRemoteMode({
        ...env,
        ATHENA_OPERATIONS_PLANE_INLINE: "true",
      })
    ).toBe(false);
    expect(
      operationsRemoteMode({
        ...env,
        ATHENA_RUNTIME_ROLE: "operations-plane",
      })
    ).toBe(false);
  });

  test("proxies timeline, graph, AICP shadow data, flows and actions over the API mTLS identity", async () => {
    const request = jest.fn().mockResolvedValue({ success: true });
    const access = new RemoteOperationsAccess({ env, request });
    await access.timeline({ operationId: "operation-1", limit: 25 });
    await access.stateGraph({ limit: 50 });
    await access.aicpTopology();
    await access.aicpTrace("trace-1");
    await access.flows({ operationId: "operation-1" });
    await access.decideAction({
      runId: "run-1",
      decision: "approved",
      actor: { type: "human" },
    });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        callerRole: "api",
        url: "https://operations-plane:3015/internal/v1/operations/timeline",
        method: "POST",
        body: { operationId: "operation-1", limit: 25 },
      })
    );
    expect(request.mock.calls.map(([input]) => input.url)).toEqual(
      expect.arrayContaining([
        "https://operations-plane:3015/internal/v1/operations/state-graph",
        "https://operations-plane:3015/internal/v1/operations/aicp/topology",
        "https://operations-plane:3015/internal/v1/operations/aicp/traces/trace-1",
        "https://operations-plane:3015/internal/v1/operations/flows",
        "https://operations-plane:3015/internal/v1/operations/actions/runs/run-1/decide",
      ])
    );
  });

  test("keeps Operations available when the isolated shadow runtime is down", async () => {
    const request = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" })
      );
    await expect(
      operationsShadowSnapshot(
        {
          ...env,
          ATHENA_RUNTIME_ROLE: "operations-plane",
          ATHENA_OPERATIONS_SHADOW_AGENTS_INLINE: "false",
          ATHENA_OPERATIONS_SHADOW_AGENTS_URL:
            "https://operations-shadow-agents:3029",
        },
        request
      )
    ).resolves.toEqual({
      success: false,
      ready: false,
      status: "degraded",
      reasonCode: "operations_shadow_agents_unavailable",
      retryable: true,
      lastError: "ECONNREFUSED",
    });
  });

  test("observes coordination lifecycle coverage without gating Operations readiness", async () => {
    const coordinationEnv = {
      ...env,
      ATHENA_RUNTIME_ROLE: "operations-plane",
      ATHENA_COORDINATION_INTERNAL_URL: "https://coordination-plane:3032/",
    };
    expect(coordinationRemoteMode(coordinationEnv)).toBe(true);
    const request = jest.fn().mockResolvedValue({
      success: true,
      coverage: { expected: 23, healthy: 23, complete: true },
    });
    await expect(
      coordinationLifecycleHealth(coordinationEnv, request)
    ).resolves.toEqual({
      enabled: true,
      status: "healthy",
      coverage: { expected: 23, healthy: 23, complete: true },
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        callerRole: "operations-plane",
        callerModule: "operations-plane",
        targetModule: "coordination-plane",
        capability: "coordination.status",
        method: "GET",
        url: "https://coordination-plane:3032/internal/v1/coordination/modules",
      })
    );

    request.mockRejectedValueOnce(
      Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" })
    );
    await expect(
      coordinationLifecycleHealth(coordinationEnv, request)
    ).resolves.toMatchObject({
      enabled: true,
      status: "unavailable",
      reasonCode: "ECONNREFUSED",
      coverage: null,
    });
  });
});
