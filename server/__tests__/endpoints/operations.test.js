/* eslint-env jest */

const {
  boundedLimit,
  filtersFromQuery,
  operationsEndpoints,
} = require("../../endpoints/operations");
const { localOperationsAccess } = require("../../utils/operations/access");

describe("Operations endpoints", () => {
  test("registers every Operations Plane API behind both auth guards", () => {
    const routes = [];
    operationsEndpoints({
      get: (...args) => routes.push(args),
      post: (...args) => routes.push(args),
    });
    expect(routes.map(([path]) => path)).toEqual([
      "/operations/client-chat-observations",
      "/operations/client-ui-observations",
      "/operations/health",
      "/operations/schemas",
      "/operations/schemas/:name/:version",
      "/operations/services",
      "/operations/agents",
      "/operations/shadow-agents",
      "/operations/evaluations/latest",
      "/operations/evaluations/corpus",
      "/operations/actions/catalog",
      "/operations/actions/runs",
      "/operations/actions/runs/:runId",
      "/operations/actions/runs",
      "/operations/actions/runs/:runId/approve",
      "/operations/actions/runs/:runId/reject",
      "/operations/actions/runs/:runId/execute",
      "/operations/actions/runs/:runId/reconcile",
      "/operations/timeline",
      "/operations/state-graph",
      "/operations/aicp/topology",
      "/operations/aicp/traces/:traceId",
      "/operations/flows",
      "/operations/explain",
    ]);
    for (const [, guards, handler] of routes) {
      expect(guards).toHaveLength(3);
      expect(guards.every((guard) => typeof guard === "function")).toBe(true);
      expect(typeof handler).toBe("function");
    }
  });

  test("bounds timeline requests and only projects supported filters", () => {
    expect(boundedLimit("900")).toBe(500);
    expect(
      filtersFromQuery({
        eventId: "event-1",
        operationId: "operation-1",
        limit: "0",
        prompt: "must-not-pass",
      })
    ).toEqual({
      after: undefined,
      before: undefined,
      eventId: "event-1",
      eventType: undefined,
      subjectId: undefined,
      operationId: "operation-1",
      traceId: undefined,
      limit: 100,
    });
  });

  test("exposes only read-only shadow state and a redacted corpus manifest", async () => {
    const routes = [];
    operationsEndpoints({
      get: (...args) => routes.push(args),
      post: (...args) => routes.push(args),
    });
    const invoke = async (path) => {
      const route = routes.find(([candidate]) => candidate === path);
      const json = jest.fn();
      const response = { status: jest.fn(() => ({ json })) };
      await route.at(-1)({}, response);
      return json.mock.calls[0][0];
    };

    const shadow = await invoke("/operations/shadow-agents");
    const evaluation = await invoke("/operations/evaluations/latest");
    const corpus = await invoke("/operations/evaluations/corpus");

    expect(shadow).toMatchObject({
      success: true,
      mode: "shadow",
      actionPolicy: "observe_only",
      canExecuteActions: false,
    });
    expect(evaluation.report.canExecuteActions).toBe(false);
    expect(
      corpus.manifest.cases.every(
        (testCase) =>
          testCase.observations === undefined && testCase.expected === undefined
      )
    ).toBe(true);
  });

  test("returns 503 instead of a false 404 when evidence is partial", async () => {
    const routes = [];
    operationsEndpoints({
      get: (...args) => routes.push(args),
      post: (...args) => routes.push(args),
    });
    jest.spyOn(localOperationsAccess, "explain").mockResolvedValueOnce({
      found: false,
      timeline: [],
      source: "nats",
      sources: ["nats", "recent-buffer"],
      degraded: true,
      completeness: "partial",
    });
    const route = routes.find(([path]) => path === "/operations/explain");
    const json = jest.fn();
    const response = {
      status: jest.fn(() => response),
      json,
    };

    await route.at(-1)({ query: { eventId: "missing-event" } }, response);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "operations_evidence_incomplete",
        completeness: "partial",
      })
    );
  });

  test("exposes read-only AICP topology and returns 404 for an unknown Trace", async () => {
    const routes = [];
    operationsEndpoints({
      get: (...args) => routes.push(args),
      post: (...args) => routes.push(args),
    });
    jest.spyOn(localOperationsAccess, "aicpTopology").mockResolvedValueOnce({
      topology: { summary: { observedLinks: 2, runtimeLinks: 2 } },
      shadow: { mode: "shadow-read-only", status: "observing" },
    });
    jest.spyOn(localOperationsAccess, "aicpTrace").mockResolvedValueOnce({
      trace: { traceId: "missing-trace", found: false, entries: [] },
    });
    const response = {
      status: jest.fn(() => response),
      json: jest.fn(),
    };

    await routes.find(([path]) => path === "/operations/aicp/topology").at(-1)(
      {},
      response
    );
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        topology: { summary: { observedLinks: 2, runtimeLinks: 2 } },
      })
    );

    response.status.mockClear();
    response.json.mockClear();
    await routes
      .find(([path]) => path === "/operations/aicp/traces/:traceId")
      .at(-1)({ params: { traceId: "missing-trace" } }, response);
    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: "operations_aicp_trace_not_found",
    });
  });

  test("accepts redacted iOS native reconnect observations", () => {
    const routes = [];
    operationsEndpoints({
      get: (...args) => routes.push(args),
      post: (...args) => routes.push(args),
    });
    const route = routes.find(
      ([path]) => path === "/operations/client-chat-observations"
    );
    const json = jest.fn();
    const response = {
      locals: { user: { id: 7, role: "default" } },
      setHeader: jest.fn(),
      status: jest.fn(() => response),
      json,
    };
    const request = {
      headers: { "x-athena-client-id": "ios-device" },
      body: {
        event: "reconnect_recovered",
        platform: "ios_native",
        visibility: "visible",
        outcome: "recovered",
        durationMs: 120,
        clientTurnId: "turn-ios",
        invocationId: "invocation-ios",
        runKind: "agent",
        transport: "websocket",
      },
    };

    route.at(-1)(request, response);

    expect(response.status).toHaveBeenCalledWith(202);
    expect(json).toHaveBeenCalledWith({ success: true, accepted: 1 });
  });

  test("accepts metadata-only Agent ledger recovery observations", () => {
    const routes = [];
    operationsEndpoints({
      get: (...args) => routes.push(args),
      post: (...args) => routes.push(args),
    });
    const route = routes.find(
      ([path]) => path === "/operations/client-chat-observations"
    );
    const json = jest.fn();
    const response = {
      locals: { user: { id: 7, role: "default" } },
      setHeader: jest.fn(),
      status: jest.fn(() => response),
      json,
    };
    const request = {
      headers: { "x-client-id": "web-device" },
      body: {
        event: "reconnect_recovered",
        platform: "desktop_web",
        visibility: "visible",
        outcome: "recovered",
        durationMs: 1,
        clientTurnId: "turn-agent",
        invocationId: "invocation-agent",
        runKind: "agent",
        transport: "ledger_poll",
      },
    };

    route.at(-1)(request, response);

    expect(response.status).toHaveBeenCalledWith(202);
    expect(json).toHaveBeenCalledWith({ success: true, accepted: 1 });
  });

  test("accepts metadata-only web history sync and memory status observations", () => {
    const routes = [];
    operationsEndpoints({
      get: (...args) => routes.push(args),
      post: (...args) => routes.push(args),
    });
    const route = routes.find(
      ([path]) => path === "/operations/client-chat-observations"
    );
    const json = jest.fn();
    const response = {
      locals: { user: { id: 7, role: "default" } },
      setHeader: jest.fn(),
      status: jest.fn(() => response),
      json,
    };
    const request = {
      headers: { "x-client-id": "mobile-web-device" },
      body: {
        observations: [
          {
            event: "history_sync_recovered",
            platform: "mobile_web",
            visibility: "visible",
            outcome: "recovered",
            durationMs: 84,
            clientTurnId: "sync:workspace:thread",
          },
          {
            event: "memory_status_failed",
            platform: "mobile_web",
            visibility: "visible",
            outcome: "failed",
            clientTurnId: "memory:workspace:thread",
          },
        ],
      },
    };

    route.at(-1)(request, response);

    expect(response.status).toHaveBeenCalledWith(202);
    expect(json).toHaveBeenCalledWith({ success: true, accepted: 2 });
  });

  test("accepts only allowlisted metadata-only workspace overview observations", () => {
    const routes = [];
    operationsEndpoints({
      get: (...args) => routes.push(args),
      post: (...args) => routes.push(args),
    });
    const route = routes.find(
      ([path]) => path === "/operations/client-ui-observations"
    );
    const json = jest.fn();
    const response = {
      locals: { user: { id: 7, role: "default" } },
      setHeader: jest.fn(),
      status: jest.fn(() => response),
      json,
    };
    const request = {
      headers: { "x-athena-client-id": "web-device" },
      body: {
        observations: [
          {
            event: "overview_recovered",
            surface: "workspace_overview",
            platform: "desktop_web",
            visibility: "visible",
            outcome: "recovered",
            reason: "scheduler_abort",
            durationMs: 184,
            retryCount: 1,
            requestId: "overview-request",
            prompt: "must-not-be-recorded",
          },
          {
            event: "passkey_cross_device_only",
            surface: "passkey_capability",
            platform: "desktop_web",
            visibility: "visible",
            outcome: "observed",
            reason: "platform_authenticator_unavailable",
            requestId: "passkey-capability-request",
            userAgent: "must-not-be-recorded",
          },
          {
            event: "arbitrary_client_event",
            surface: "workspace_overview",
          },
        ],
      },
    };

    route.at(-1)(request, response);

    expect(response.status).toHaveBeenCalledWith(202);
    expect(json).toHaveBeenCalledWith({ success: true, accepted: 2 });
  });
});
