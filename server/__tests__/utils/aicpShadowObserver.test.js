/* eslint-env jest */

const {
  AicpShadowObserver,
} = require("../../utils/modulePlatform/aicp/shadowObserver");

describe("AICP shadow runtime observation", () => {
  test("projects real semantic events into Event, Link and Trace evidence", () => {
    const observer = new AicpShadowObserver({ env: {} });
    const event = {
      eventId: "event-crypto-read",
      eventType: "crypto.account.read.completed",
      category: "crypto-account-access",
      outcome: "success",
      occurredAt: "2026-08-01T12:00:00.000Z",
      producer: { runtimeRole: "api", service: "athena-server" },
      subject: { component: "crypto-account-access" },
      correlation: {
        traceId: "0123456789abcdef0123456789abcdef",
        operationId: "operation-crypto-read",
      },
    };

    expect(observer.observeSemanticEvent(event)).toMatchObject({
      accepted: true,
      moduleId: "crypto-account-access",
      contractConformant: true,
    });
    expect(observer.observeSemanticEvent(event)).toEqual({
      accepted: false,
      reason: "duplicate",
    });

    const topology = observer.topology();
    expect(topology.summary.observedLinks).toBeGreaterThanOrEqual(2);
    expect(topology.summary.runtimeLinks).toBe(1);
    expect(topology.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "event",
          from: "crypto-account-access",
          to: "operations-plane",
          capability: "crypto.account.read.completed",
          source: "runtime-observation",
          state: expect.objectContaining({ status: "observed" }),
        }),
      ])
    );
    expect(observer.trace(event.correlation.traceId)).toMatchObject({
      found: true,
      entries: [
        expect.objectContaining({
          kind: "event",
          eventId: event.eventId,
          moduleId: "crypto-account-access",
        }),
      ],
    });
    expect(observer.health()).toMatchObject({
      semanticEvents: 1,
      duplicateEvents: 1,
      mappedEvents: 1,
      contractDriftEvents: 0,
    });
  });

  test("records actual internal RPC links without retaining URL or body data", () => {
    const observer = new AicpShadowObserver({ env: {} });
    const traceId = "abcdef0123456789abcdef0123456789";
    const result = observer.observeRpcCall({
      callerRole: "agent-runtime",
      url: "https://tool-runtime:3016/internal/v1/tools/invoke?secret=ignored",
      method: "POST",
      outcome: "success",
      durationMs: 42,
      statusCode: 200,
      context: { traceId, operationId: "operation-tool" },
    });

    expect(result).toMatchObject({
      accepted: true,
      from: "agent-runtime",
      to: "tool-runtime",
    });
    const rpcLink = observer
      .topology()
      .links.find(
        (link) => link.source === "runtime-observation" && link.type === "rpc"
      );
    expect(rpcLink).toMatchObject({
      from: "agent-runtime",
      to: "tool-runtime",
      capability: "POST /internal/v1/tools/invoke",
      transport: "mtls-https",
      state: expect.objectContaining({ latencyMs: 42, errorRate: 0 }),
    });
    expect(JSON.stringify(rpcLink)).not.toContain("secret=ignored");
    expect(JSON.stringify(observer.trace(traceId))).not.toContain(
      "tool-runtime:3016"
    );
  });

  test("reconstructs sampled RPC links from Operations semantic telemetry", () => {
    const observer = new AicpShadowObserver({ env: {} });
    const result = observer.observeSemanticEvent({
      eventId: "event-rpc-shadow",
      eventType: "aicp.rpc.observed",
      category: "aicp_shadow",
      outcome: "success",
      occurredAt: "2026-08-01T12:00:00.000Z",
      subject: {
        id: "rpc-observation-1",
        component: "agent-runtime",
        operation: "POST /internal/v1/tools/invoke",
      },
      impact: { scope: "tool-runtime" },
      metadata: {
        backend: "mtls-https",
        durationMs: "37",
        statusCode: "200",
      },
      correlation: {
        traceId: "22222222222222222222222222222222",
        operationId: "operation-sampled-rpc",
      },
    });

    expect(result).toMatchObject({
      accepted: true,
      from: "agent-runtime",
      to: "tool-runtime",
      capability: "POST /internal/v1/tools/invoke",
    });
    expect(observer.health()).toMatchObject({ rpcCalls: 1, rpcFailures: 0 });
    expect(
      observer.trace("22222222222222222222222222222222").entries[0]
    ).toMatchObject({ kind: "rpc", durationMs: 37, statusCode: 200 });
  });

  test("aggregates failures into link error rate and redacted Trace metadata", () => {
    const observer = new AicpShadowObserver({ env: {} });
    const base = {
      from: "agent-runtime",
      to: "tool-runtime",
      capability: "POST /internal/v1/tools/invoke",
      transport: "mtls-https",
      context: { traceId: "44444444444444444444444444444444" },
    };
    observer.observeResolvedRpc({
      ...base,
      observationId: "rpc-success",
      outcome: "success",
      durationMs: 20,
      statusCode: 200,
    });
    observer.observeResolvedRpc({
      ...base,
      observationId: "rpc-failure",
      outcome: "failed",
      durationMs: 40,
      statusCode: 504,
      errorCode: "INTERNAL_SERVICE_TIMEOUT",
    });

    const link = observer
      .runtimeLinkSnapshot()
      .find((candidate) => candidate.capability === base.capability);
    expect(link.state).toMatchObject({
      status: "degraded",
      latencyMs: 30,
      errorRate: 0.5,
    });
    expect(observer.trace(base.context.traceId).entries.at(-1)).toMatchObject({
      outcome: "failed",
      statusCode: 504,
      errorCode: "INTERNAL_SERVICE_TIMEOUT",
    });
    expect(observer.health()).toMatchObject({ rpcCalls: 2, rpcFailures: 1 });
  });

  test("reports contract drift without rejecting the observed business event", () => {
    const observer = new AicpShadowObserver({ env: {} });
    expect(
      observer.observeSemanticEvent({
        eventId: "event-chat-client",
        eventType: "chat.client.reconnect_recovered",
        category: "chat_client",
        outcome: "recovered",
        producer: { runtimeRole: "api" },
        subject: {},
        correlation: {},
      })
    ).toMatchObject({
      accepted: true,
      moduleId: "chat-runtime",
      contractConformant: false,
    });
    expect(observer.health().contractDriftEvents).toBe(1);
  });

  test("can be disabled without affecting callers", () => {
    const observer = new AicpShadowObserver({
      env: { ATHENA_AICP_SHADOW_OBSERVATION_ENABLED: "false" },
    });
    expect(
      observer.observeSemanticEvent({
        eventId: "event-disabled",
        eventType: "chat.run.completed",
      })
    ).toEqual({ accepted: false, reason: "disabled" });
    expect(observer.health()).toMatchObject({
      enabled: false,
      status: "disabled",
      semanticEvents: 0,
    });
  });

  test("does not guess a module from an ambiguous loopback lifecycle path", () => {
    const observer = new AicpShadowObserver({ env: {} });
    expect(
      observer.observeRpcCall({
        callerRole: "athena-api",
        url: "http://127.0.0.1:39000/internal/drain",
        outcome: "success",
      })
    ).toEqual({ accepted: false, reason: "rpc_route_unresolved" });
    expect(observer.health().rpcCalls).toBe(0);
  });

  test("normalizes undeclared internal RPC routes and reports contract drift", () => {
    const observer = new AicpShadowObserver({ env: {} });
    const result = observer.observeRpcCall({
      callerRole: "athena-api",
      url: "https://scheduler:3014/internal/v1/tasks/private-account/42?token=secret",
      method: "POST",
      outcome: "failed",
      errorCode: "INTERNAL_SERVICE_REJECTED",
    });

    expect(result).toMatchObject({
      accepted: true,
      to: "scheduler",
      capability: "POST undeclared-internal-route",
      contractConformant: false,
    });
    expect(observer.health()).toMatchObject({
      rpcCalls: 1,
      rpcContractDriftCalls: 1,
    });
    expect(JSON.stringify(observer.topology())).not.toContain(
      "private-account"
    );
    expect(JSON.stringify(observer.topology())).not.toContain("secret");
  });
});
