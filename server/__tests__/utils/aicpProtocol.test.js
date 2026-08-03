const {
  AicpCapabilityRegistry,
  buildRuntimeTopology,
  createAicpEnvelope,
  createModuleHealth,
  phase0McpTools,
  validateAicpEnvelope,
  validateModuleHealth,
} = require("../../utils/modulePlatform/aicp");

describe("Athena Internal Capability Protocol", () => {
  test("derives a read-only capability catalog from the manifest registry", () => {
    const registry = new AicpCapabilityRegistry();
    const catalog = registry.catalog();

    expect(catalog.protocol.phase).toBe(
      "production-contracts-shadow-enforcement"
    );
    expect(catalog.modules.length).toBeGreaterThanOrEqual(20);
    expect(catalog.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "module.describe", readOnly: true }),
        expect.objectContaining({ id: "module.self-test", readOnly: true }),
        expect.objectContaining({ id: "topology.query", readOnly: true }),
      ])
    );
    expect(catalog.capabilities.some((entry) => entry.readOnly === false)).toBe(
      false
    );
  });

  test("binds envelopes to capability, target, deadline, scope and payload hash", () => {
    const envelope = createAicpEnvelope({
      callType: "Describe",
      capability: "module.describe",
      producer: "operations-plane",
      target: "chat-runtime",
      correlationId: "correlation:test",
      auth: {
        principalAssertionId: "principal:test",
        scopes: ["module:describe"],
      },
      payload: { include: ["runtime", "links"] },
    });

    expect(validateAicpEnvelope(envelope)).toEqual({
      valid: true,
      findings: [],
    });
    expect(envelope.payloadHash).toMatch(/^[a-f0-9]{64}$/);

    const tampered = { ...envelope, payload: { include: ["secrets"] } };
    expect(validateAicpEnvelope(tampered).findings).toContain(
      "payload_hash_mismatch"
    );
  });

  test("rejects sensitive payload fields and unapproved control calls", () => {
    expect(() =>
      createAicpEnvelope({
        callType: "Query",
        capability: "topology.query",
        producer: "operations-plane",
        target: "operations-plane",
        auth: {
          principalAssertionId: "principal:test",
          scopes: ["topology:read"],
        },
        payload: { apiSecret: "must-not-cross-aicp" },
      })
    ).toThrow("aicp_envelope_invalid");

    expect(() =>
      createAicpEnvelope({
        callType: "Command",
        capability: "module.restart",
        producer: "operations-plane",
        target: "chat-runtime",
        idempotencyKey: "restart:test",
        auth: {
          principalAssertionId: "principal:test",
          scopes: ["module:control"],
        },
        payload: {},
      })
    ).toThrow("aicp_envelope_invalid");
  });

  test("generates deterministic module descriptions without leaking runtime details", async () => {
    const registry = new AicpCapabilityRegistry();
    registry.registerRuntimeProvider("chat-runtime", {
      runtime: async () => ({
        status: "running",
        ready: true,
        inflight: 2,
        lastError: "Authorization: Bearer should-not-be-returned",
        internalObject: { shouldNot: "appear" },
        counters: { submitted: 12, opaque: "not-a-number" },
      }),
    });

    const description = await registry.describe("chat-runtime");
    expect(description.module.id).toBe("chat-runtime");
    expect(description.operations.maximumDefaultLevel).toBe("L2");
    expect(description.operations.controlExposedByAicpPhase0).toBe(false);
    expect(description.runtime.internalObject).toBeUndefined();
    expect(description.runtime.lastError).toBeUndefined();
    expect(description.runtime.lastErrorCode).toBe("runtime_error_redacted");
    expect(description.runtime.counters).toEqual({ submitted: 12 });
  });

  test("enforces scope before dispatching a read-only capability", async () => {
    const registry = new AicpCapabilityRegistry();
    const denied = createAicpEnvelope({
      callType: "Describe",
      capability: "module.describe",
      producer: "operations-plane",
      target: "chat-runtime",
      auth: {
        principalAssertionId: "principal:test",
        scopes: ["topology:read"],
      },
      payload: {},
    });
    await expect(registry.dispatch(denied)).rejects.toMatchObject({
      code: "AICP_PRINCIPAL_UNVERIFIED",
      httpStatus: 401,
    });
    await expect(
      registry.dispatch(denied, {
        principalVerified: true,
        authorizedScopes: ["topology:read"],
      })
    ).rejects.toMatchObject({
      code: "AICP_SCOPE_DENIED",
      httpStatus: 403,
    });

    const allowed = createAicpEnvelope({
      callType: "Describe",
      capability: "module.describe",
      producer: "operations-plane",
      target: "chat-runtime",
      auth: {
        principalAssertionId: "principal:test",
        scopes: ["module:describe"],
      },
      payload: {},
    });
    await expect(
      registry.dispatch(allowed, {
        principalVerified: true,
        authorizedScopes: ["module:describe"],
      })
    ).resolves.toMatchObject({
      module: { id: "chat-runtime" },
    });
  });

  test("projects manifest dependencies, RPC, events and data as first-class links", () => {
    const topology = buildRuntimeTopology();
    expect(topology.summary.modules).toBeGreaterThanOrEqual(20);
    expect(topology.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "rpc",
          from: "agent-runtime",
          to: "tool-runtime",
          capability: "tool.invoke",
        }),
        expect.objectContaining({ type: "event", transport: "nats-jetstream" }),
        expect.objectContaining({ type: "data", transport: "postgresql" }),
        expect.objectContaining({ type: "key-domain", to: "key-custody" }),
      ])
    );
    expect(new Set(topology.links.map((link) => link.id)).size).toBe(
      topology.links.length
    );
  });

  test("does not report an unobserved module as healthy", () => {
    const health = createModuleHealth({
      moduleId: "crypto-market",
      source: "none",
      runtime: {},
    });

    expect(health).toMatchObject({
      status: "unmonitored",
      ready: null,
      source: "none",
    });
    expect(health.healthScore).toBeLessThan(100);
    expect(validateModuleHealth(health)).toEqual({
      valid: true,
      findings: [],
    });
  });

  test("builds MCP-compatible adapters without registering a second runtime", async () => {
    const registry = new AicpCapabilityRegistry();
    const tools = phase0McpTools(registry, {
      principalAssertionId: "principal:test",
      scopes: ["module:describe", "module:self-test"],
      authorize: async () => ({
        verified: true,
        scopes: ["module:describe", "module:self-test"],
      }),
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      "athena_module_describe",
      "athena_module_self_test",
    ]);
    await expect(
      tools[0].handler({ moduleId: "operations-plane" })
    ).resolves.toMatchObject({ module: { id: "operations-plane" } });
  });
});
