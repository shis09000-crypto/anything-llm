const {
  MicroModuleServiceHost,
  internalPeerAuthorized,
  requestInternalService,
} = require("../../utils/microModules");
const {
  moduleManifest,
} = require("../../utils/modulePlatform/manifestRegistry");

describe("MicroModuleServiceHost", () => {
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
      internalPeerAuthorized(
        request,
        moduleManifest("crypto-account-access"),
        {
          APP_ENV: "production",
          ATHENA_RUNTIME_TOPOLOGY: "distributed",
        }
      )
    ).toEqual({
      authorized: true,
      caller: "spiffe://athena/production/tool-broker",
    });
  });
});
