/* eslint-env jest */

const {
  buildAuthBootstrap,
  validRpConfiguration,
} = require("../../utils/authz/authBootstrap");

function request({ host = "athenallm.online", proto = "https" } = {}) {
  return {
    protocol: proto,
    headers: {
      host,
      "x-forwarded-proto": proto,
      "x-athena-web-protocol-version": "1",
    },
  };
}

describe("Identity auth bootstrap", () => {
  test("is independent of the main API and exposes only the public auth contract", async () => {
    const payload = await buildAuthBootstrap({
      request: request(),
      settings: { isMultiUserMode: jest.fn().mockResolvedValue(true) },
      env: {
        NODE_ENV: "production",
        DEPLOYMENT_VERSION: "v-test",
        PASSKEY_ORIGIN: "https://athenallm.online",
        PASSKEY_RP_ID: "athenallm.online",
      },
    });

    expect(payload).toMatchObject({
      schemaVersion: "athena.auth.bootstrap.v1",
      serviceStatus: "ready",
      authMode: "multi",
      nextAction: "continue",
      methods: {
        password: { enabled: true },
        passkey: {
          enabled: true,
          crossDeviceAllowed: true,
          rpIdValid: true,
        },
      },
      deployment: {
        releaseId: "v-test",
        authEpoch: 1,
        minimumAuthEpoch: 1,
      },
    });
    expect(JSON.stringify(payload)).not.toMatch(/database|module|topology/i);
  });

  test("ordinary releases do not require reauthentication", async () => {
    const payload = await buildAuthBootstrap({
      request: request(),
      settings: { isMultiUserMode: jest.fn().mockResolvedValue(true) },
      env: {
        NODE_ENV: "production",
        DEPLOYMENT_VERSION: "new-release",
        ATHENA_AUTH_EPOCH: "8",
        ATHENA_MINIMUM_AUTH_EPOCH: "1",
      },
    });
    expect(payload.nextAction).toBe("continue");
    expect(payload.deployment.authEpoch).toBe(8);
  });

  test("rejects insecure or mismatched passkey RP configuration", () => {
    expect(
      validRpConfiguration(request({ proto: "http" }), {
        PASSKEY_ORIGIN: "http://athenallm.online",
      })
    ).toBe(false);
    expect(
      validRpConfiguration(request(), {
        PASSKEY_ORIGIN: "https://login.athenallm.online",
        PASSKEY_RP_ID: "example.com",
      })
    ).toBe(false);
  });

  test("uses the original forwarded host behind the Identity edge proxy", () => {
    expect(
      validRpConfiguration(
        {
          protocol: "https",
          headers: {
            host: "anything-llm-identity:3026",
            "x-forwarded-host": "athenallm.online",
            "x-forwarded-proto": "https",
          },
        },
        {}
      )
    ).toBe(true);
  });

  test("uses the configured public app URL when the edge omits forwarded host", () => {
    expect(
      validRpConfiguration(
        request({ host: "anything-llm-identity:3026" }),
        { PUBLIC_APP_URL: "https://athenallm.online" }
      )
    ).toBe(true);
  });
});
