const {
  AicpContractRegistry,
  aicpLinkEnforcementMode,
  validateCoordinationContext,
} = require("../../utils/modulePlatform/aicp/contractRegistry");

describe("AicpContractRegistry", () => {
  test("negotiates declared provider, consumer, caller and schema contracts", () => {
    const registry = new AicpContractRegistry();
    const caller = registry.manifests.find(
      (manifest) => manifest.contracts.consumes.length > 0
    );
    const consumed = caller.contracts.consumes[0];
    const provider = [...registry.providers.get(consumed.id)][0];

    expect(provider).toBeTruthy();
    const link = registry.negotiate({
      callerModule: caller.id,
      targetModule: provider.manifest.id,
      capability: consumed.id,
      version: consumed.version,
      callType: consumed.callType,
    });

    expect(link).toMatchObject({
      state: "negotiated",
      callerModule: caller.id,
      targetModule: provider.manifest.id,
      capability: consumed.id,
    });
    expect(link.contractFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test("rejects unknown and undeclared callers instead of falling back", () => {
    const registry = new AicpContractRegistry();
    const provider = [...registry.providers.values()][0][0];

    expect(() =>
      registry.negotiate({
        callerModule: "unknown-module",
        targetModule: provider.manifest.id,
        capability: provider.contract.id,
      })
    ).toThrow("aicp_caller_module_unknown");
  });

  test("negotiates the API to Browser Plane capability closure", () => {
    const registry = new AicpContractRegistry();
    for (const capability of [
      "browser.node",
      "browser.session",
      "browser.workspace",
    ]) {
      expect(
        registry.negotiate({
          callerModule: "athena-api",
          targetModule: "browser-plane",
          capability,
          version: "1.0",
        })
      ).toMatchObject({
        state: "negotiated",
        callerModule: "athena-api",
        targetModule: "browser-plane",
        capability,
      });
    }
  });

  test("negotiates legacy v1.0 RPC declarations during rolling migration", () => {
    const registry = new AicpContractRegistry({
      manifests: () => [
        {
          id: "legacy-caller",
          runtimeRole: "legacy-caller",
          rpc: { provides: [], consumes: ["identity.session.validate"] },
          security: { allowedCallers: [] },
        },
        {
          id: "legacy-provider",
          runtimeRole: "legacy-provider",
          rpc: { provides: ["identity.session.validate"], consumes: [] },
          security: { allowedCallers: ["legacy-caller"] },
        },
      ],
    });
    expect(
      registry.negotiate({
        callerModule: "legacy-caller",
        targetModule: "legacy-provider",
        capability: "identity.session.validate",
      })
    ).toMatchObject({
      capability: "identity.session.validate",
      version: "1.0",
      callType: "Query",
    });
  });

  test("rejects expired coordination deadlines", () => {
    const result = validateCoordinationContext(
      {
        coordinationRunId: "run-1",
        stepId: "step-1",
        center: "task",
        correlationId: "correlation-1",
        causationId: null,
        deadlineAt: new Date(Date.now() - 1_000).toISOString(),
        priority: "P2",
        idempotencyKey: "idem-1",
      },
      { required: true }
    );
    expect(result.valid).toBe(false);
    expect(result.findings).toContain("deadline_expired");
  });

  test("enforces only Manifest-selected links during observe rollout", () => {
    const env = { ATHENA_AICP_ENFORCEMENT_MODE: "observe" };
    expect(
      aicpLinkEnforcementMode({
        callerModule: "chat-runtime",
        targetModule: "coordination-plane",
        capability: "coordination.lifecycle.heartbeat",
        env,
      })
    ).toBe("enforce");
    expect(
      aicpLinkEnforcementMode({
        callerModule: "chat-runtime",
        targetModule: "coordination-plane",
        capability: "coordination.status",
        env,
      })
    ).toBe("observe");
    expect(
      aicpLinkEnforcementMode({
        callerModule: "chat-runtime",
        targetModule: "operations-plane",
        capability: "operations.ingest-batch",
        env,
      })
    ).toBe("enforce");
  });
});
