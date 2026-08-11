const {
  AicpContractRegistry,
  AicpNdjsonWriter,
  AicpStreamSequence,
  aicpSchemaRegistry,
  auditAicpClosure,
  createAicpContext,
  createAicpEvent,
  createStreamFrame,
  invokeLocalCapability,
  readAicpNdjson,
  validateAicpContext,
  validateAicpEvent,
} = require("../../utils/modulePlatform/aicp");
const { PassThrough } = require("stream");

describe("AICP protocol 1.1 runtime enforcement", () => {
  test("binds a call to its capability, route, payload, deadline and idempotency key", () => {
    const negotiation = new AicpContractRegistry().negotiate({
      callerModule: "coordination-plane",
      targetModule: "operations-plane",
      capability: "operations.catalog",
      protocolVersion: "1.1",
    });
    const payload = { include: ["modules"] };
    const context = createAicpContext({
      negotiation,
      payload,
      method: "POST",
      path: "/internal/v1/operations/catalog",
      idempotencyKey: "catalog:test",
    });

    expect(
      validateAicpContext(context, {
        payload,
        method: "POST",
        path: "/internal/v1/operations/catalog",
      })
    ).toEqual({ valid: true, findings: [] });
    expect(
      validateAicpContext(context, {
        payload: { include: ["secrets"] },
        method: "POST",
        path: "/internal/v1/operations/catalog",
      }).findings
    ).toContain("payload_hash_mismatch");
    expect(
      validateAicpContext(context, {
        payload,
        method: "GET",
        path: "/internal/v1/operations/catalog",
      }).findings
    ).toContain("request_binding_hash_mismatch");
  });

  test("requires one monotonic stream lifecycle and exactly one terminal frame", () => {
    const sequence = new AicpStreamSequence("stream:test");
    const open = createStreamFrame({
      streamId: "stream:test",
      sequence: 0,
      type: "open",
      payload: { resumed: false },
    });
    const data = createStreamFrame({
      streamId: "stream:test",
      sequence: 1,
      type: "data",
      payload: { delta: "hello" },
    });
    const terminal = createStreamFrame({
      streamId: "stream:test",
      sequence: 2,
      type: "terminal",
      terminalStatus: "completed",
      payload: { usage: { outputTokens: 1 } },
    });

    expect(sequence.accept(open).valid).toBe(true);
    expect(sequence.accept(data).valid).toBe(true);
    expect(sequence.accept(terminal).valid).toBe(true);
    expect(sequence.complete()).toBe(true);
    expect(sequence.accept(terminal).findings).toContain("sequence_gap");

    const gap = new AicpStreamSequence("stream:gap");
    gap.accept(
      createStreamFrame({
        streamId: "stream:gap",
        sequence: 0,
        type: "open",
      })
    );
    expect(
      gap.accept(
        createStreamFrame({
          streamId: "stream:gap",
          sequence: 2,
          type: "data",
        })
      ).findings
    ).toContain("sequence_gap");
  });

  test("dual-reads legacy NDJSON and enforces the v1.1 terminal lifecycle", async () => {
    const transport = new PassThrough();
    const writer = new AicpNdjsonWriter(transport, {
      aicp: { context: { schemaVersion: "1.1" } },
      streamId: "stream:ndjson",
    });
    writer.open({ capability: "model.stream" });
    writer.data({ chunk: { text: "hello" } });
    writer.end("completed", { usage: { outputTokens: 1 } });

    const projected = [];
    for await (const value of readAicpNdjson(transport)) projected.push(value);
    expect(projected.map((value) => value.frame.type)).toEqual([
      "open",
      "data",
      "terminal",
    ]);
    expect(projected[1].payload).toEqual({ chunk: { text: "hello" } });

    const legacy = new PassThrough();
    legacy.end('{"chunk":{"text":"legacy"}}\n{"end":true}\n');
    const legacyValues = [];
    for await (const value of readAicpNdjson(legacy))
      legacyValues.push(value.payload);
    expect(legacyValues).toEqual([
      { chunk: { text: "legacy" } },
      { end: true },
    ]);
  });

  test("validates event fingerprints, ordering and payload integrity before ACK", () => {
    const fingerprint = "a".repeat(64);
    const event = createAicpEvent({
      eventType: "module.lifecycle.transitioned",
      producer: "coordination-plane",
      target: "operations-plane",
      capability: "operations.ingest-batch",
      capabilityFingerprint: fingerprint,
      schemaFingerprint: "b".repeat(64),
      correlationId: "correlation:test",
      partitionKey: "module:chat-runtime",
      sequence: 7,
      subject: { type: "module", id: "chat-runtime" },
      payload: { state: "ready" },
    });

    expect(validateAicpEvent(event)).toEqual({ valid: true, findings: [] });
    expect(validateAicpEvent(event, { previousSequence: 5 }).findings).toContain(
      "sequence_gap"
    );
    expect(
      validateAicpEvent({ ...event, payload: { state: "failed" } }).findings
    ).toContain("payload_hash_mismatch");
  });

  test("uses the same schema and contract gate for local in-process calls", async () => {
    const output = await invokeLocalCapability({
      callerModule: "coordination-plane",
      targetModule: "operations-plane",
      capability: "operations.catalog",
      body: { include: ["modules"] },
      idempotencyKey: "local:catalog:test",
      handler: async (body, { context }) => ({
        success: true,
        echoed: body.include,
        protocol: context.schemaVersion,
      }),
    });

    expect(output.result).toMatchObject({
      success: true,
      echoed: ["modules"],
      protocol: "1.1",
    });
    expect(output.metadata.resultHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("loads and compiles the immutable build-time schema catalog", () => {
    const registry = aicpSchemaRegistry();
    expect(registry.summary()).toMatchObject({
      schema: "athena.aicp.schema-catalog",
      schemaVersion: "1.1",
      count: 347,
    });
    expect(registry.summary().digest).toMatch(/^[a-f0-9]{64}$/);
    expect(
      registry.validate("athena://contracts/operations.catalog/error/1.0", {
        success: false,
        error: "dependency_unavailable",
        reasonCode: "operations_catalog_unavailable",
      }).valid
    ).toBe(true);
    expect(
      registry.validate("athena://contracts/operations.catalog/error/1.0", {
        success: false,
        error: "dependency_unavailable",
        reasonCode: "operations_catalog_unavailable",
        stack: "must-not-cross-the-contract",
      }).valid
    ).toBe(false);
  });

  test("closes every declared contract, route, schema, event and source call", () => {
    const audit = auditAicpClosure();
    expect(audit.valid).toBe(true);
    expect(audit.findings).toEqual([]);
    expect(audit.summary).toMatchObject({
      modules: 25,
      contractDeclarations: 474,
      routeBindings: 275,
      schemaArtifacts: 347,
      sourceCalls: 48,
      findings: 0,
    });
  });
});
