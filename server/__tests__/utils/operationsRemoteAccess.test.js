/* eslint-env jest */

const {
  RemoteOperationsAccess,
  operationsRemoteMode,
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

  test("proxies timeline, graph, flows and actions over the API mTLS identity", async () => {
    const request = jest.fn().mockResolvedValue({ success: true });
    const access = new RemoteOperationsAccess({ env, request });
    await access.timeline({ operationId: "operation-1", limit: 25 });
    await access.stateGraph({ limit: 50 });
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
        "https://operations-plane:3015/internal/v1/operations/flows",
        "https://operations-plane:3015/internal/v1/operations/actions/runs/run-1/decide",
      ])
    );
  });
});
