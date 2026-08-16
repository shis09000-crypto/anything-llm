/* eslint-env jest */

const {
  aicpRequestHeaders,
  requestInternalService,
} = require("../../utils/microModules/internalClient");
const {
  MicroModuleServiceHost,
} = require("../../utils/microModules/serviceHost");
const {
  aicpShadowObserver,
} = require("../../utils/modulePlatform/aicp/shadowObserver");
const {
  runWithOperationContext,
} = require("../../utils/observability/operationContext");

describe("AICP internal RPC shadow integration", () => {
  afterEach(() => aicpShadowObserver.reset());

  test("observes a real internal HTTP call without changing its response", async () => {
    aicpShadowObserver.reset();
    const host = new MicroModuleServiceHost({
      manifestId: "operations-plane",
      role: "operations-plane",
      port: 0,
      env: {
        NODE_ENV: "test",
        APP_ENV: "test",
        ATHENA_RUNTIME_TOPOLOGY: "local",
      },
      registerRoutes: (app) => {
        app.get("/internal/v1/operations/shadow-probe", (_request, response) =>
          response.json({ success: true, value: "unchanged" })
        );
      },
    });
    await host.start();

    const traceId = "11111111111111111111111111111111";
    try {
      const response = await runWithOperationContext(
        { traceId, operationId: "operation-shadow-http" },
        () =>
          requestInternalService({
            callerRole: "api",
            url: `http://127.0.0.1:${host.port}/internal/v1/operations/shadow-probe`,
            method: "GET",
            env: {
              NODE_ENV: "test",
              ATHENA_RUNTIME_TOPOLOGY: "local",
            },
          })
      );
      expect(response).toEqual({ success: true, value: "unchanged" });
      expect(aicpShadowObserver.trace(traceId)).toMatchObject({
        found: true,
        entries: [
          expect.objectContaining({
            kind: "rpc",
            from: "athena-api",
            to: "operations-plane",
            capability: "GET /internal/v1/operations/",
            outcome: "success",
          }),
        ],
      });
    } finally {
      await host.stop();
    }
  });

  test("inherits the unchanged frontend task priority for module RPC steps", () => {
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const headers = runWithOperationContext(
      {
        operationId: "operation-task-priority",
        correlationId: "correlation-task-priority",
        coordinationRunId: "coordination-task-priority",
        stepId: "step-task-priority",
        coordinationCenter: "task",
        coordinationDeadlineAt: deadlineAt,
        taskPriority: "P1",
      },
      () =>
        aicpRequestHeaders({
          callerRole: "athena-api",
          targetModule: "authentication",
          capability: "identity.client.attach",
          contractVersion: "1.0",
          env: { ATHENA_AICP_ENFORCEMENT_MODE: "observe" },
        })
    );
    const context = JSON.parse(
      Buffer.from(headers["x-athena-aicp-coordination"], "base64url").toString(
        "utf8"
      )
    );
    expect(context).toEqual({
      coordinationRunId: "coordination-task-priority",
      stepId: "step-task-priority",
      correlationId: "correlation-task-priority",
      center: "task",
      priority: "P1",
      deadlineAt,
      causationId: "operation-task-priority",
    });
  });

  test("drops an expired inherited coordination context for ordinary RPCs", () => {
    const headers = runWithOperationContext(
      {
        operationId: "operation-expired-context",
        correlationId: "correlation-expired-context",
        coordinationRunId: "coordination-expired-context",
        stepId: "step-expired-context",
        coordinationCenter: "task",
        coordinationDeadlineAt: new Date(Date.now() - 1_000).toISOString(),
        taskPriority: "P1",
      },
      () =>
        aicpRequestHeaders({
          callerRole: "athena-api",
          targetModule: "authentication",
          capability: "identity.client.attach",
          contractVersion: "1.0",
          env: { ATHENA_AICP_ENFORCEMENT_MODE: "observe" },
        })
    );

    expect(headers["x-athena-aicp-coordination"]).toBeUndefined();
  });

  test("rejects an invalid coordination context supplied explicitly", () => {
    expect(() =>
      aicpRequestHeaders({
        callerRole: "athena-api",
        targetModule: "authentication",
        capability: "identity.client.attach",
        contractVersion: "1.0",
        coordinationContext: {
          coordinationRunId: "coordination-explicit-expired",
          stepId: "step-explicit-expired",
          correlationId: "correlation-explicit-expired",
          center: "task",
          priority: "P1",
          deadlineAt: new Date(Date.now() - 1_000).toISOString(),
        },
        env: { ATHENA_AICP_ENFORCEMENT_MODE: "observe" },
      })
    ).toThrow("aicp_coordination_context_invalid");
  });
});
