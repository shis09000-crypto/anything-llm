const {
  MicroModuleServiceHost,
  internalPeerAuthorized,
  requestInternalService,
} = require("../../utils/microModules");
const {
  moduleManifest,
} = require("../../utils/modulePlatform/manifestRegistry");
const {
  internalRouteCapability,
} = require("../../utils/microModules/serviceHost");

describe("MicroModuleServiceHost", () => {
  test("resolves method-specific dynamic AICP route capabilities", () => {
    const capabilities = {
      "GET /internal/v1/responses/:responseId": "responses.retrieve",
      "DELETE /internal/v1/responses/:responseId": "responses.delete",
    };
    expect(
      internalRouteCapability(
        capabilities,
        "GET",
        "/internal/v1/responses/ath_resp_1"
      )
    ).toBe("responses.retrieve");
    expect(
      internalRouteCapability(
        capabilities,
        "DELETE",
        "/internal/v1/responses/ath_resp_1"
      )
    ).toBe("responses.delete");
  });

  test("hosts a manifest-bound module and drains new work", async () => {
    const lifecycle = [];
    const host = new MicroModuleServiceHost({
      manifestId: "operations-plane",
      role: "operations-plane",
      port: 0,
      env: {
        NODE_ENV: "test",
        APP_ENV: "test",
        ATHENA_RUNTIME_TOPOLOGY: "local",
      },
      onStart: async () => lifecycle.push("start"),
      onDrain: async () => lifecycle.push("drain"),
      onStop: async () => lifecycle.push("stop"),
      registerRoutes: (app) => {
        app.post("/internal/v1/test", (_request, response) =>
          response.json({ success: true, value: "ok" })
        );
      },
    });

    const started = await host.start();
    expect(started.ready).toBe(true);
    expect(started.manifestFingerprint).toMatch(/^[a-f0-9]{64}$/);

    await expect(
      requestInternalService({
        callerRole: "athena-api",
        url: `http://127.0.0.1:${host.port}/internal/v1/test`,
        env: {
          NODE_ENV: "test",
          ATHENA_RUNTIME_TOPOLOGY: "local",
        },
      })
    ).resolves.toMatchObject({ success: true, value: "ok" });

    await expect(
      requestInternalService({
        callerRole: "athena-api",
        url: `http://127.0.0.1:${host.port}/internal/drain`,
        env: {
          NODE_ENV: "test",
          ATHENA_RUNTIME_TOPOLOGY: "local",
        },
      })
    ).resolves.toMatchObject({ success: true, status: "draining" });

    await expect(
      requestInternalService({
        callerRole: "athena-api",
        url: `http://127.0.0.1:${host.port}/internal/v1/test`,
        env: {
          NODE_ENV: "test",
          ATHENA_RUNTIME_TOPOLOGY: "local",
        },
      })
    ).rejects.toMatchObject({ httpStatus: 503 });

    await host.stop();
    expect(lifecycle).toEqual(["start", "drain", "stop"]);
  });

  test("round-trips an AICP v1.1 call with schema, result hash and cancellation enforcement", async () => {
    let serverObservedAbort = false;
    let markRouteEntered;
    const routeEntered = new Promise((resolve) => {
      markRouteEntered = resolve;
    });
    const host = new MicroModuleServiceHost({
      manifestId: "operations-plane",
      role: "operations-plane",
      port: 0,
      env: {
        NODE_ENV: "test",
        APP_ENV: "test",
        ATHENA_RUNTIME_TOPOLOGY: "local",
        ATHENA_AICP_EMIT_VERSION: "1.1",
        ATHENA_AICP_ENFORCEMENT_MODE: "enforce",
      },
      registerRoutes: (app) => {
        app.get(
          "/internal/v1/operations/health",
          (request, response) => {
            expect(response.locals.aicp.context.schemaVersion).toBe("1.1");
            expect(response.locals.aicp.context.capability.id).toBe(
              "operations.catalog"
            );
            response.json({ success: true, modules: [] });
          }
        );
        app.post(
          "/internal/v1/operations/ingest-batch",
          (_request, response) => {
            markRouteEntered();
            response.locals.aicp.abortSignal.addEventListener(
              "abort",
              () => {
                serverObservedAbort = true;
              },
              { once: true }
            );
          }
        );
      },
    });

    await host.start();
    try {
      const env = {
        NODE_ENV: "test",
        APP_ENV: "test",
        ATHENA_RUNTIME_TOPOLOGY: "local",
        ATHENA_AICP_EMIT_VERSION: "1.1",
        ATHENA_AICP_ENFORCEMENT_MODE: "enforce",
      };
      await expect(
        requestInternalService({
          callerRole: "coordination-plane",
          callerModule: "coordination-plane",
          targetModule: "operations-plane",
          capability: "operations.catalog",
          url: `http://127.0.0.1:${host.port}/internal/v1/operations/health`,
          method: "GET",
          env,
        })
      ).resolves.toEqual({ success: true, modules: [] });

      const controller = new AbortController();
      const pending = requestInternalService({
        callerRole: "coordination-plane",
        callerModule: "coordination-plane",
        targetModule: "operations-plane",
        capability: "operations.ingest-batch",
        url: `http://127.0.0.1:${host.port}/internal/v1/operations/ingest-batch`,
        body: { events: [] },
        idempotencyKey: "runtime-action:cancel-test",
        durableIdempotency: true,
        signal: controller.signal,
        env,
      });
      await routeEntered;
      controller.abort();
      await expect(pending).rejects.toMatchObject({
        code: "INTERNAL_SERVICE_ABORTED",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(serverObservedAbort).toBe(true);
    } finally {
      await host.stop();
    }
  });

  test("refuses cleartext internal RPC in distributed topology", async () => {
    await expect(
      requestInternalService({
        callerRole: "athena-api",
        url: "http://scheduler:3014/internal/v1/test",
        env: {
          NODE_ENV: "production",
          ATHENA_RUNTIME_TOPOLOGY: "distributed",
        },
      })
    ).rejects.toMatchObject({ code: "INTERNAL_SERVICE_TLS_REQUIRED" });
  });

  test("contains rejected async RPC handlers without terminating the host", async () => {
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
        app.post("/internal/v1/reject", async () => {
          throw Object.assign(new Error("scoped_runtime_failure"), {
            httpStatus: 503,
          });
        });
        app.get("/internal/v1/still-alive", async (_request, response) => {
          await Promise.resolve();
          response.json({ success: true });
        });
      },
    });

    await host.start();
    await expect(
      requestInternalService({
        callerRole: "athena-api",
        url: `http://127.0.0.1:${host.port}/internal/v1/reject`,
        env: { NODE_ENV: "test", ATHENA_RUNTIME_TOPOLOGY: "local" },
      })
    ).rejects.toMatchObject({
      httpStatus: 503,
      message: "scoped_runtime_failure",
    });
    await expect(
      requestInternalService({
        callerRole: "athena-api",
        url: `http://127.0.0.1:${host.port}/internal/v1/still-alive`,
        method: "GET",
        env: { NODE_ENV: "test", ATHENA_RUNTIME_TOPOLOGY: "local" },
      })
    ).resolves.toMatchObject({ success: true });

    expect(host.snapshot()).toMatchObject({
      status: "running",
      ready: true,
      lastError: "scoped_runtime_failure",
    });
    await host.stop();
  });

  test("maps allowed module ids to their runtime service identities", () => {
    const request = {
      socket: {
        authorized: true,
        getPeerCertificate: () => ({
          subjectaltname: "URI:spiffe://athena/production/tool-broker",
        }),
      },
    };
    expect(
      internalPeerAuthorized(request, moduleManifest("crypto-account-access"), {
        APP_ENV: "production",
        ATHENA_RUNTIME_TOPOLOGY: "distributed",
      })
    ).toEqual({
      authorized: true,
      caller: "spiffe://athena/production/tool-broker",
    });
  });

  test("enforces target-bound lifecycle contracts and Operations approval", async () => {
    const env = {
      NODE_ENV: "test",
      APP_ENV: "test",
      ATHENA_RUNTIME_TOPOLOGY: "local",
      ATHENA_AICP_ENFORCEMENT_MODE: "enforce",
    };
    const host = new MicroModuleServiceHost({
      manifestId: "operations-plane",
      role: "operations-plane",
      port: 0,
      env,
      principalAssertionVerifier: async () => ({ valid: true }),
      operationsApprovalVerifier: async () => ({ valid: true }),
    });
    await host.start();
    const context = {
      coordinationRunId: "coordination:test",
      stepId: "step:quiesce",
      center: "recovery",
      correlationId: "correlation:test",
      causationId: null,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      priority: "P2",
      idempotencyKey: "module-quiesce:test",
    };

    await expect(
      requestInternalService({
        callerRole: "coordination-plane",
        targetModule: "operations-plane",
        capability: "module.lifecycle.query",
        method: "GET",
        url: `http://127.0.0.1:${host.port}/internal/v1/lifecycle`,
        env,
      })
    ).resolves.toMatchObject({ success: true, moduleId: "operations-plane" });

    await expect(
      requestInternalService({
        callerRole: "coordination-plane",
        targetModule: "operations-plane",
        capability: "module.quiesce",
        coordinationContext: context,
        principalAssertion: { assertionId: "principal:test" },
        method: "POST",
        body: { reasonCode: "test_quiesce" },
        url: `http://127.0.0.1:${host.port}/internal/v1/quiesce`,
        env,
      })
    ).rejects.toMatchObject({
      reasonCode: "aicp_operations_approval_required",
    });

    await expect(
      requestInternalService({
        callerRole: "coordination-plane",
        targetModule: "operations-plane",
        capability: "module.quiesce",
        coordinationContext: context,
        principalAssertion: { assertionId: "principal:test" },
        approvalId: "operations-approval:test",
        method: "POST",
        body: { reasonCode: "test_quiesce" },
        url: `http://127.0.0.1:${host.port}/internal/v1/quiesce`,
        env,
      })
    ).resolves.toMatchObject({ success: true, status: "quiesced" });

    await host.stop();
  });

  test("fails lifecycle commands closed when approval or principal verifiers are absent", async () => {
    const env = {
      NODE_ENV: "test",
      APP_ENV: "test",
      ATHENA_RUNTIME_TOPOLOGY: "local",
      ATHENA_AICP_ENFORCEMENT_MODE: "observe",
    };
    const host = new MicroModuleServiceHost({
      manifestId: "operations-plane",
      role: "operations-plane",
      port: 0,
      env,
    });
    await host.start();
    const coordinationContext = {
      coordinationRunId: "coordination:locked",
      stepId: "step:quiesce",
      center: "recovery",
      correlationId: "correlation:locked",
      causationId: null,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      priority: "P2",
      idempotencyKey: "module-quiesce:locked",
    };
    await expect(
      requestInternalService({
        callerRole: "coordination-plane",
        targetModule: "operations-plane",
        capability: "module.quiesce",
        coordinationContext,
        principalAssertion: { assertionId: "unverified" },
        approvalId: "unverified",
        method: "POST",
        body: { reasonCode: "must_not_run" },
        url: `http://127.0.0.1:${host.port}/internal/v1/quiesce`,
        env,
      })
    ).rejects.toMatchObject({
      reasonCode: "aicp_operations_approval_verifier_missing",
    });
    expect(host.snapshot()).toMatchObject({
      status: "running",
      lifecycle: { state: "ready" },
    });
    await host.stop();
  });

  test("does not accept an unverified lifecycle principal in observe mode", async () => {
    const env = {
      NODE_ENV: "test",
      APP_ENV: "test",
      ATHENA_RUNTIME_TOPOLOGY: "local",
      ATHENA_AICP_ENFORCEMENT_MODE: "observe",
    };
    const host = new MicroModuleServiceHost({
      manifestId: "operations-plane",
      role: "operations-plane",
      port: 0,
      env,
      operationsApprovalVerifier: async () => ({ valid: true }),
    });
    await host.start();
    await expect(
      requestInternalService({
        callerRole: "coordination-plane",
        targetModule: "operations-plane",
        capability: "module.quiesce",
        coordinationContext: {
          coordinationRunId: "coordination:principal-locked",
          stepId: "step:quiesce",
          center: "recovery",
          correlationId: "correlation:principal-locked",
          causationId: null,
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
          priority: "P2",
          idempotencyKey: "module-quiesce:principal-locked",
        },
        principalAssertion: { assertionId: "unverified" },
        approvalId: "verified-approval",
        method: "POST",
        body: { reasonCode: "must_not_run" },
        url: `http://127.0.0.1:${host.port}/internal/v1/quiesce`,
        env,
      })
    ).rejects.toMatchObject({
      reasonCode: "aicp_principal_verifier_missing",
    });
    expect(host.snapshot()).toMatchObject({
      status: "running",
      lifecycle: { state: "ready" },
    });
    await host.stop();
  });

  test("enforces a selected Manifest link while unrelated links remain observed", async () => {
    const env = {
      NODE_ENV: "test",
      APP_ENV: "test",
      ATHENA_RUNTIME_TOPOLOGY: "local",
      ATHENA_AICP_ENFORCEMENT_MODE: "observe",
    };
    const route = "/internal/v1/coordination/modules/heartbeat";
    const host = new MicroModuleServiceHost({
      manifestId: "coordination-plane",
      role: "coordination-plane",
      port: 0,
      env,
      internalRouteCapabilities: {
        [route]: "coordination.lifecycle.heartbeat",
      },
      registerRoutes: (app) => {
        app.post(route, (_request, response) =>
          response.json({ success: true })
        );
      },
    });
    await host.start();
    await expect(
      requestInternalService({
        callerRole: "chat-runtime",
        method: "POST",
        body: {},
        url: `http://127.0.0.1:${host.port}${route}`,
        env,
      })
    ).rejects.toMatchObject({
      httpStatus: 409,
      reasonCode: "aicp_contract_context_missing",
    });
    await expect(
      requestInternalService({
        callerRole: "chat-runtime",
        targetModule: "coordination-plane",
        capability: "coordination.lifecycle.heartbeat",
        coordinationContext: {
          coordinationRunId: "coordination:heartbeat",
          stepId: "step:heartbeat",
          center: "recovery",
          correlationId: "correlation:heartbeat",
          causationId: null,
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
          priority: "P2",
          idempotencyKey: "heartbeat:test",
        },
        method: "POST",
        body: {},
        url: `http://127.0.0.1:${host.port}${route}`,
        env,
      })
    ).resolves.toEqual({ success: true });
    await host.stop();
  });
});
