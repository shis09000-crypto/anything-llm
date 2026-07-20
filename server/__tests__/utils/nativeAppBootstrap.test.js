process.env.ENCRYPTION_MASTER_KEY =
  process.env.ENCRYPTION_MASTER_KEY ||
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.STORAGE_DIR =
  process.env.STORAGE_DIR || "/tmp/anythingllm-native-app-bootstrap-test";

const {
  IOS_MINIMUM_OS_VERSION,
  NATIVE_APP_PROTOCOL_VERSION,
  READER_MAX_UPLOAD_BYTES,
  appleAppSiteAssociation,
  buildNativeAppBootstrap,
  buildNativeAppPreflight,
  compareVersions,
} = require("../../utils/nativeAppBootstrap");

describe("native app bootstrap contract", () => {
  it("compares native app versions without pulling a semver dependency", () => {
    expect(compareVersions("1.2.0", "1.2")).toBe(0);
    expect(compareVersions("1.2.1", "1.2.0")).toBe(1);
    expect(compareVersions("1.2.0", "1.3.0")).toBe(-1);
    expect(compareVersions("1.2-beta", "1.2.0")).toBeNull();
  });

  it("returns the iOS 26 native protocol contract", () => {
    const bootstrap = buildNativeAppBootstrap({
      env: {
        NODE_ENV: "production",
        ENABLE_HTTPS: "true",
        DEPLOYMENT_VERSION: "2.2.4",
      },
      generatedAt: new Date("2026-07-08T00:00:00.000Z"),
    });

    expect(bootstrap).toMatchObject({
      success: true,
      protocolVersion: NATIVE_APP_PROTOCOL_VERSION,
      generatedAt: "2026-07-08T00:00:00.000Z",
      app: {
        name: "Athena",
        platform: "ios",
        platforms: ["ios", "ipad"],
        minimumOSVersion: IOS_MINIMUM_OS_VERSION,
        deploymentVersion: "2.2.4",
        liquidGlass: {
          nativeRequired: true,
          swiftUIAvailability: "iOS 26+",
          fallbackPromised: false,
        },
      },
      features: {
        readerMaxUploadBytes: READER_MAX_UPLOAD_BYTES,
        syncV2: false,
      },
      endpoints: {
        bootstrapPath: "/api/native-app/bootstrap",
        preflightPath: "/api/native-app/preflight",
      },
    });
  });

  it("reflects production transport status without requiring auth", () => {
    const bootstrap = buildNativeAppBootstrap({
      env: {
        NODE_ENV: "production",
        TRUST_PROXY: "true",
        FORCE_HTTPS: "true",
        PUBLIC_APP_URL: "https://athena.example.com/",
      },
    });

    expect(bootstrap.transport.publicAppUrl).toBe("https://athena.example.com");
    expect(bootstrap.transport.httpsRequired).toBe(true);
    expect(bootstrap.transport.webSocketSecureRequired).toBe(true);
    expect(bootstrap.transport.runtime).toMatchObject({
      mode: "trusted_proxy",
      production: true,
      httpsRequired: true,
      trustProxyEnabled: true,
      forceHttps: true,
      publicAppUrlHttps: true,
      webSocketSecureRequired: true,
    });
  });

  it("keeps first native release boundaries explicit", () => {
    const bootstrap = buildNativeAppBootstrap();

    expect(bootstrap.auth.appleSignInAvailable).toBe(false);
    expect(bootstrap.auth.appleSignIn.available).toBe(false);
    expect(bootstrap.auth.nativePasskey.serverAvailable).toBe(true);
    expect(bootstrap.features.nativePush).toBe(false);
    expect(bootstrap.features.webPushOnly).toBe(true);
    expect(bootstrap.features.admin).toBe(false);
    expect(bootstrap.features.crypto).toBe(false);
    expect(bootstrap.features.localModel).toBe(false);
    expect(bootstrap.features.fullOffline).toBe(false);
    expect(bootstrap.features.syncV2).toBe(false);
    expect(bootstrap.readiness.p0).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "client_identity_request_signing",
          status: "ready",
        }),
        expect.objectContaining({
          id: "native_auth_keychain",
          status: "requires_native_client",
        }),
      ])
    );
  });

  it("exposes Sync V2 as an independently controlled native capability", () => {
    const bootstrap = buildNativeAppBootstrap({
      env: { ATHENA_SYNC_V2_ENABLED: "true" },
    });

    expect(bootstrap.features.syncV2).toBe(true);
  });

  it("returns null version policy values when optional env is unset", () => {
    const bootstrap = buildNativeAppBootstrap({
      env: { NODE_ENV: "production", ENABLE_HTTPS: "true" },
    });

    expect(bootstrap.app.versionPolicy).toEqual({
      minSupportedAppVersion: null,
      recommendedAppVersion: null,
    });
  });

  it("does not leak secret or user-specific env values", () => {
    const secretEnv = {
      NODE_ENV: "production",
      ENABLE_HTTPS: "true",
      JWT_SECRET: "jwt_secret_value_that_must_not_leak",
      AUTH_TOKEN: "auth_token_value_that_must_not_leak",
      ENCRYPTION_MASTER_KEY:
        "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      OPENAI_API_KEY: "sk-secret-value-that-must-not-leak",
      ATHENA_IOS_MIN_SUPPORTED_APP_VERSION: "1.0.0",
      ATHENA_IOS_RECOMMENDED_APP_VERSION: "1.1.0",
    };
    const bootstrap = buildNativeAppBootstrap({ env: secretEnv });
    const serialized = JSON.stringify(bootstrap);

    expect(bootstrap.app.versionPolicy).toEqual({
      minSupportedAppVersion: "1.0.0",
      recommendedAppVersion: "1.1.0",
    });
    expect(serialized).not.toContain(secretEnv.JWT_SECRET);
    expect(serialized).not.toContain(secretEnv.AUTH_TOKEN);
    expect(serialized).not.toContain(secretEnv.ENCRYPTION_MASTER_KEY);
    expect(serialized).not.toContain(secretEnv.OPENAI_API_KEY);
  });

  it("preflights iOS app version and OS compatibility", () => {
    const env = {
      NODE_ENV: "production",
      ENABLE_HTTPS: "true",
      ATHENA_IOS_MIN_SUPPORTED_APP_VERSION: "1.2.0",
      ATHENA_IOS_RECOMMENDED_APP_VERSION: "1.4.0",
    };

    expect(
      buildNativeAppPreflight({
        env,
        query: { platform: "ios", appVersion: "1.1.9", osVersion: "26.0" },
      })
    ).toMatchObject({
      compatible: false,
      blocked: true,
      reasons: ["app_version_blocked"],
    });

    expect(
      buildNativeAppPreflight({
        env,
        query: { platform: "ios", appVersion: "1.3.0", osVersion: "26.1" },
      })
    ).toMatchObject({
      compatible: true,
      blocked: false,
      updateRecommended: true,
      warnings: ["app_update_recommended"],
    });
  });

  it("blocks preflight below iOS 26 and unsupported platforms", () => {
    expect(
      buildNativeAppPreflight({
        query: { platform: "android", appVersion: "1.0.0", osVersion: "25.7" },
      })
    ).toMatchObject({
      compatible: false,
      blocked: true,
      reasons: ["unsupported_platform", "minimum_ios_26_required"],
    });
  });

  it("builds apple app site association only when associated domain env is present", () => {
    expect(appleAppSiteAssociation({}).configured).toBe(false);

    const association = appleAppSiteAssociation({
      PUBLIC_APP_URL: "https://athena.example.com",
      ATHENA_IOS_TEAM_ID: "TEAM123456",
      ATHENA_IOS_BUNDLE_ID: "com.example.athena",
      ATHENA_IOS_UNIVERSAL_LINK_PATHS: "/,/workspace/*",
    });

    expect(association).toMatchObject({
      configured: true,
      links: {
        appId: "TEAM123456.com.example.athena",
        paths: ["/", "/workspace/*"],
        domain: "athena.example.com",
      },
      payload: {
        applinks: {
          apps: [],
          details: [
            {
              appID: "TEAM123456.com.example.athena",
              paths: ["/", "/workspace/*"],
            },
          ],
        },
        webcredentials: {
          apps: ["TEAM123456.com.example.athena"],
        },
      },
    });
  });
});
