/* eslint-env jest */

const {
  ModuleHealthMonitor,
  normalizedRemoteState,
  parseEndpointMap,
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
