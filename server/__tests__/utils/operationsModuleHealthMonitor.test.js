/* eslint-env jest */

const {
  ModuleHealthMonitor,
  normalizedRemoteState,
  parseEndpointMap,
  parseExpectedModuleStates,
} = require("../../utils/operations/moduleHealthMonitor");

const manifest = {
  id: "chat-runtime",
  version: "1.2.3",
  fingerprint: "expected-fingerprint",
  security: { failureMode: "fail-closed" },
  deployment: { readinessPath: "/ready" },
};

describe("Operations module health monitor", () => {
  test("combines explicit endpoint maps with conventional runtime URLs", () => {
    expect(
      parseEndpointMap({
        ATHENA_MODULE_RUNTIME_ENDPOINTS: JSON.stringify({
          "chat-runtime": "https://chat-explicit:3016/",
        }),
        ATHENA_CHAT_UPSTREAM: "https://chat-conventional:3016",
        ATHENA_MODEL_GATEWAY_URL: "https://model:3018/",
      })
    ).toEqual({
      "chat-runtime": "https://chat-explicit:3016",
      "model-gateway": "https://model:3018",
    });
  });

  test("requires physical endpoints unless legacy colocated probes are explicit", () => {
    expect(
      parseEndpointMap({
        ATHENA_API_INTERNAL_URL: "https://api:3024",
        ATHENA_IDENTITY_URL: "https://identity:3026",
        ATHENA_KNOWLEDGE_INGEST_URL: "https://ingest:3027",
        ATHENA_RAG_URL: "https://rag:3028",
        ATHENA_OPERATIONS_SHADOW_AGENTS_URL: "https://shadow:3029",
      })
    ).toMatchObject({
      "athena-api": "https://api:3024",
      authentication: "https://identity:3026",
      "knowledge-ingest": "https://ingest:3027",
      rag: "https://rag:3028",
      "operations-shadow-agents": "https://shadow:3029",
    });
    expect(
      parseEndpointMap({
        ATHENA_API_INTERNAL_URL: "https://api:3024",
      })
    ).toEqual({ "athena-api": "https://api:3024" });
    expect(
      parseEndpointMap({
        ATHENA_API_INTERNAL_URL: "https://api:3024",
        ATHENA_ALLOW_COLOCATED_MODULE_PROBES: "true",
      })
    ).toMatchObject({
      authentication: {
        url: "https://api:3024",
        readinessPath: "/internal/v1/module-readiness/authentication",
      },
    });
  });

  test("excludes explicitly maintained modules from readiness without reporting a crash", async () => {
    expect(
      parseExpectedModuleStates({
        ATHENA_EXPECTED_MODULE_STATES:
          "crypto-forecast=maintenance,reader-worker=running",
      })
    ).toEqual({
      "crypto-forecast": "maintenance",
      "reader-worker": "running",
    });
    const maintained = {
      ...manifest,
      id: "crypto-forecast",
    };
    const monitor = new ModuleHealthMonitor({
      env: {
        ATHENA_EXPECTED_MODULE_STATES: JSON.stringify({
          "crypto-forecast": "maintenance",
        }),
      },
      request: jest.fn(),
      emit: jest.fn(),
      manifests: () => [maintained],
    });
    monitor.started = true;
    await monitor.refresh();
    expect(monitor.request).not.toHaveBeenCalled();
    expect(monitor.snapshot()).toMatchObject({
      status: "running",
      modules: [
        {
          moduleId: "crypto-forecast",
          expectedState: "maintenance",
          status: "inactive",
          reasonCode: "module_expected_maintenance",
        },
      ],
      summary: {
        total: 1,
        active: 0,
        inactive: 1,
        degraded: 0,
        complete: false,
      },
    });
    await monitor.stop();
  });

  test("rejects version, manifest, and identity drift", () => {
    expect(
      normalizedRemoteState(
        manifest,
        {
          moduleId: "agent-runtime",
          version: manifest.version,
          manifestFingerprint: manifest.fingerprint,
          ready: true,
        },
        3
      )
    ).toMatchObject({
      status: "degraded",
      reasonCode: "module_identity_mismatch",
    });
    expect(
      normalizedRemoteState(
        manifest,
        {
          moduleId: manifest.id,
          version: "9.9.9",
          manifestFingerprint: manifest.fingerprint,
          ready: true,
        },
        3
      )
    ).toMatchObject({
      status: "degraded",
      reasonCode: "module_version_mismatch",
    });
    expect(
      normalizedRemoteState(
        manifest,
        {
          moduleId: manifest.id,
          version: manifest.version,
          manifestFingerprint: "wrong",
          ready: true,
        },
        3
      )
    ).toMatchObject({
      status: "degraded",
      reasonCode: "module_manifest_mismatch",
    });
  });

  test("observes compatible contract drift during a staged rollout", async () => {
    const request = jest.fn().mockResolvedValue({
      moduleId: manifest.id,
      version: "1.0.0",
      manifestFingerprint: "previous-release-fingerprint",
      ready: true,
    });
    const monitor = new ModuleHealthMonitor({
      env: {
        ATHENA_AICP_READINESS_ENFORCEMENT: "false",
        ATHENA_MODULE_RUNTIME_ENDPOINTS: JSON.stringify({
          [manifest.id]: "https://chat:3016",
        }),
      },
      request,
      emit: jest.fn(),
      manifests: () => [manifest],
    });

    monitor.started = true;
    await monitor.refresh();
    expect(monitor.snapshot()).toMatchObject({
      status: "running",
      modules: [
        {
          moduleId: manifest.id,
          status: "healthy",
          ready: true,
          compatibilityStatus: "contract_drift_observed",
          observedVersion: "1.0.0",
        },
      ],
      summary: { complete: true, healthy: 1, degraded: 0 },
    });
    await monitor.stop();
  });

  test("probes configured modules and emits metadata-only transitions", async () => {
    const emit = jest.fn();
    const request = jest.fn().mockResolvedValue({
      moduleId: manifest.id,
      version: manifest.version,
      manifestFingerprint: manifest.fingerprint,
      ready: true,
    });
    const monitor = new ModuleHealthMonitor({
      env: {
        ATHENA_MODULE_RUNTIME_ENDPOINTS: JSON.stringify({
          [manifest.id]: "https://chat:3016",
        }),
      },
      request,
      emit,
      manifests: () => [manifest],
    });

    monitor.started = true;
    await monitor.refresh();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        callerRole: "operations-plane",
        url: "https://chat:3016/ready",
        method: "GET",
      })
    );
    expect(monitor.snapshot()).toMatchObject({
      status: "running",
      summary: { total: 1, healthy: 1, degraded: 0, unmonitored: 0 },
    });

    request.mockRejectedValueOnce(
      Object.assign(new Error("connection refused"), {
        code: "ECONNREFUSED",
      })
    );
    await monitor.refresh();
    expect(monitor.snapshot().modules[0]).toMatchObject({
      status: "degraded",
      ready: false,
      reasonCode: "ECONNREFUSED",
    });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "module.health.changed",
        category: "module_health",
        sensitivity: "metadata_only",
        subject: expect.objectContaining({ component: manifest.id }),
      })
    );
    await monitor.stop();
  });
});
