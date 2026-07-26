const mockFindUnique = jest.fn();
const mockFindMany = jest.fn();
const mockFindFirst = jest.fn();
const mockCreate = jest.fn();
const mockUpsert = jest.fn();
const mockUpdate = jest.fn();
const mockUpdateMany = jest.fn();
const mockLogEvent = jest.fn();
const mockUserFindUnique = jest.fn();
const mockRevokeClientSessions = jest.fn();
const mockVaultRegistrationUpdateMany = jest.fn();

jest.mock("../../utils/prisma", () => {
  const database = {
    athena_clients: {
      findUnique: (...args) => mockFindUnique(...args),
      findMany: (...args) => mockFindMany(...args),
      findFirst: (...args) => mockFindFirst(...args),
      create: (...args) => mockCreate(...args),
      upsert: (...args) => mockUpsert(...args),
      update: (...args) => mockUpdate(...args),
      updateMany: (...args) => mockUpdateMany(...args),
    },
    vault_device_key_registrations: {
      updateMany: (...args) => mockVaultRegistrationUpdateMany(...args),
    },
    users: {
      findUnique: (...args) => mockUserFindUnique(...args),
    },
  };
  database.$transaction = (callback) => callback(database);
  return database;
});

jest.mock("../../models/authSession", () => ({
  AuthSession: {
    revokeClient: (...args) => mockRevokeClientSessions(...args),
  },
}));

jest.mock("../../models/eventLogs", () => ({
  EventLogs: {
    logEvent: (...args) => mockLogEvent(...args),
  },
}));

const {
  clientIdentityMiddleware,
  getClientContext,
  listUserClients,
  recordClientTrustCheckpoint,
  registerClient,
  revokeAllOtherClients,
  revokeClient,
  resolveTrustLevel,
  attachAuthenticatedClientContext,
} = require("../../utils/clientIdentity");
const { clientIdentityEndpoints } = require("../../endpoints/clientIdentity");
const { registry } = require("../../utils/observability/metrics");

function requestDouble({ headers = {}, query = {} } = {}) {
  const lowerHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    headers: lowerHeaders,
    query,
    header(name) {
      return lowerHeaders[String(name).toLowerCase()] || null;
    },
  };
}

function encodedProfile(profile) {
  return Buffer.from(JSON.stringify(profile), "utf8").toString("base64url");
}

describe("client identity helpers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindUnique.mockResolvedValue(null);
    mockFindMany.mockResolvedValue([]);
    mockFindFirst.mockResolvedValue(null);
    mockCreate.mockResolvedValue({ id: 1 });
    mockUpsert.mockImplementation((args) =>
      mockCreate({ data: args.create })
    );
    mockUpdate.mockResolvedValue({ id: 1 });
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockLogEvent.mockResolvedValue({ eventLog: { id: 1 }, message: null });
    mockUserFindUnique.mockResolvedValue({ authUserId: 100 });
    mockRevokeClientSessions.mockResolvedValue({ count: 1 });
    mockVaultRegistrationUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("parses client context from HTTP headers", () => {
    const request = requestDouble({
      headers: {
        "X-Athena-Client-Id": "client_abc",
        "X-Athena-Platform": "desktop",
        "X-Athena-App-Version": "1.9.2",
        "X-Athena-Request-Id": "req_1",
      },
    });

    const context = getClientContext(request, { user: { id: 10 } });
    expect(context).toMatchObject({
      clientId: "client_abc",
      platform: "desktop",
      appVersion: "1.9.2",
      requestId: "req_1",
      trustLevel: "medium",
      userId: 10,
      capabilitySource: "unknown",
      publicKey: null,
      deviceFingerprintVersion: null,
      legacy: false,
    });
  });

  it("accepts only bounded hybrid-signed Vault KEM observations", async () => {
    const routes = {};
    const app = {
      get: jest.fn(),
      post(path, _middleware, handler) {
        routes[`POST ${path}`] = handler;
      },
    };
    clientIdentityEndpoints(app);
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await routes["POST /client-identity/crypto-observations"](
      {
        body: {
          category: "vault_kem",
          operation: "unseal",
          suiteId: "vault-xwing-mldsa65-v1",
          outcome: "aead_failed",
        },
        clientContext: {
          userId: 10,
          clientId: "client_abc",
          platform: "ios",
          legacy: false,
        },
        signedRequest: { ok: true, postQuantumVerified: true },
      },
      response
    );

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({ success: true });
    const output = await registry.metrics();
    expect(output).toContain(
      'athena_crypto_vault_kem_operations_total{operation="unseal",outcome="aead_failed"'
    );
    expect(output).toContain(
      'purpose="vault-device-authorization",suite="vault-xwing-mldsa65-v1",operation="unseal",outcome="aead_failed"'
    );
  });

  it("parses websocket query metadata and preserves legacy fallback", () => {
    const websocketRequest = requestDouble({
      query: {
        athenaClientId: "client_ws",
        athenaPlatform: "ios",
        athenaAppVersion: "mobile-test",
        athenaRequestId: "ws_req",
      },
    });
    expect(getClientContext(websocketRequest)).toMatchObject({
      clientId: "client_ws",
      platform: "ios",
      appVersion: "mobile-test",
      requestId: "ws_req",
      trustLevel: "medium",
      legacy: false,
    });

    const legacy = getClientContext(requestDouble());
    expect(legacy).toMatchObject({
      clientId: "legacy",
      platform: "api",
      trustLevel: "low",
      legacy: true,
    });
  });

  it("parses capability profile from headers and derives adaptive summary", () => {
    const profile = {
      viewport: { width: 390, height: 844, devicePixelRatio: 3 },
      input: { touch: true, hover: false, pointer: "coarse" },
      surface: "pwa",
      capabilities: {
        camera: true,
        microphone: true,
        filePicker: true,
        notifications: true,
        clipboard: true,
      },
    };
    const request = requestDouble({
      headers: {
        "X-Athena-Client-Id": "client_touch",
        "X-Athena-Platform": "web",
        "X-Athena-Capability-Source": "detected",
        "X-Athena-Capability-Profile": encodedProfile(profile),
      },
    });

    const context = getClientContext(request, { user: { id: 10 } });
    expect(context).toMatchObject({
      clientId: "client_touch",
      capabilitySource: "detected",
      layoutMode: "mobile",
      inputMode: "touch",
      surface: "pwa",
      capabilityProfile: profile,
    });
    expect(context.capabilities).toMatchObject({
      clipboard: true,
      camera: true,
      microphone: true,
      filePicker: true,
      profile,
    });
  });

  it("preserves iPad platform and device profile without mapping it to generic iOS", () => {
    const profile = {
      viewport: { width: 820, height: 1180, devicePixelRatio: 2 },
      input: { touch: true, hover: false, pointer: "coarse" },
      surface: "browser",
      device: { formFactor: "tablet", family: "ipad", os: "ipados" },
      capabilities: {
        camera: true,
        microphone: true,
        filePicker: true,
        notifications: true,
        clipboard: true,
      },
    };
    const request = requestDouble({
      headers: {
        "X-Athena-Client-Id": "client_ipad",
        "X-Athena-Platform": "ipad",
        "X-Athena-Capability-Source": "detected",
        "X-Athena-Capability-Profile": encodedProfile(profile),
      },
    });

    const context = getClientContext(request, { user: { id: 10 } });
    expect(context).toMatchObject({
      clientId: "client_ipad",
      platform: "ipad",
      trustLevel: "medium",
      layoutMode: "tablet",
      inputMode: "touch",
      surface: "browser",
      capabilityProfile: profile,
    });
    expect(context.capabilities.profile.device).toEqual({
      formFactor: "tablet",
      family: "ipad",
      os: "ipados",
    });
  });

  it("falls back safely when capability profile is malformed", () => {
    const request = requestDouble({
      query: {
        athenaClientId: "client_bad_profile",
        athenaPlatform: "desktop",
        athenaCapabilitySource: "detected",
        athenaCapabilityProfile: "not-json",
      },
    });

    const context = getClientContext(request);
    expect(context).toMatchObject({
      clientId: "client_bad_profile",
      platform: "desktop",
      capabilitySource: "detected",
      capabilityProfile: null,
    });
    expect(context.layoutMode).toBeUndefined();
    expect(context.capabilities).toMatchObject({
      fileSystem: true,
      localModel: true,
      clipboard: true,
    });
  });

  it("persists detected capability profile in existing client capabilities JSON", async () => {
    const profile = {
      viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
      input: { touch: false, hover: true, pointer: "fine" },
      surface: "browser",
      capabilities: {
        camera: false,
        microphone: false,
        filePicker: true,
        notifications: true,
        clipboard: true,
      },
    };

    await registerClient({
      userId: 10,
      clientId: "client_profile",
      platform: "web",
      capabilities: {
        clipboard: true,
        profile,
      },
      capabilitySource: "detected",
    });

    const payload = mockCreate.mock.calls[0][0];
    expect(JSON.parse(payload.data.capabilities)).toMatchObject({
      clipboard: true,
      profile,
    });
    expect(payload.data.capabilitySource).toBe("detected");
  });

  it("registers authenticated clients without sensitive future fields", async () => {
    await registerClient({
      userId: 10,
      clientId: "client_abc",
      platform: "web",
      appVersion: "1.9.2",
      capabilities: { clipboard: true },
      capabilitySource: "unknown",
    });

    const lookup = mockFindUnique.mock.calls[0][0];
    expect(lookup.where.userId_clientId).toEqual({
      userId: 10,
      clientId: "client_abc",
    });
    const payload = mockCreate.mock.calls[0][0];
    expect(payload.data).toMatchObject({
      userId: 10,
      clientId: "client_abc",
      platform: "web",
      trustLevel: "low",
      appVersion: "1.9.2",
      capabilitySource: "unknown",
      publicKey: null,
      deviceFingerprintVersion: null,
    });
    expect(payload.data.capabilities).toBe(JSON.stringify({ clipboard: true }));
  });

  it("persists device public-key algorithm and protection metadata", async () => {
    await registerClient({
      userId: 10,
      clientId: "client_secure_enclave",
      platform: "ios",
      publicKey: "public-jwk",
      deviceFingerprintVersion: "p256-secure-enclave-v1",
    });

    expect(mockCreate.mock.calls[0][0].data).toMatchObject({
      publicKey: "public-jwk",
      deviceFingerprintVersion: "p256-secure-enclave-v1",
      publicKeyAlgorithm: "ECDSA-P256-SHA256",
      publicKeyParameterSet: "secp256r1",
      publicKeyOrigin: "apple-secure-enclave",
      publicKeyHardwareProtection: "client-asserted-hardware-backed",
    });
  });

  it("serializes concurrent registration and never overwrites a bound device key", async () => {
    let stored = null;
    let creates = 0;
    mockFindUnique.mockImplementation(async ({ where }) => {
      if (where?.userId_clientId) return stored;
      if (where?.id) return stored;
      return null;
    });
    mockUpsert.mockImplementation(async ({ create, update }) => {
      if (!stored) {
        creates += 1;
        stored = { id: 51, revokedAt: null, ...create };
      } else {
        stored = { ...stored, ...update };
      }
      return { ...stored };
    });
    mockUpdateMany.mockImplementation(async ({ where, data }) => {
      if (where?.publicKey === null && stored && !stored.publicKey) {
        stored = { ...stored, ...data };
        return { count: 1 };
      }
      return { count: 0 };
    });

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        registerClient({
          userId: 10,
          clientId: "client_race",
          platform: "web",
          appVersion: `1.0.${index}`,
          publicKey: index === 0 ? "bound-device-key" : "competing-device-key",
          deviceFingerprintVersion: "p256-v1",
        })
      )
    );

    expect(creates).toBe(1);
    expect(results).toHaveLength(50);
    expect(stored.publicKey).toBe("bound-device-key");
  });

  it("does not revive revoked clients during registration", async () => {
    const revokedAt = new Date();
    mockFindUnique.mockResolvedValueOnce({
      id: 1,
      clientId: "client_abc",
      userId: 10,
      revokedAt,
    });

    const result = await registerClient({
      userId: 10,
      clientId: "client_abc",
      platform: "web",
    });

    expect(result.revokedAt).toBe(revokedAt);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("hydrates authenticated request context and skips legacy persistence", async () => {
    const legacyRequest = requestDouble();
    await attachAuthenticatedClientContext({
      request: legacyRequest,
      user: { id: 10 },
    });
    expect(legacyRequest.clientContext.userId).toBe(10);
    expect(mockCreate).not.toHaveBeenCalled();

    const request = requestDouble({
      headers: { "X-Athena-Client-Id": "client_abc" },
    });
    await attachAuthenticatedClientContext({ request, user: { id: 10 } });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("lists user clients without exposing sensitive fields", async () => {
    const revokedAt = new Date();
    mockFindMany.mockResolvedValueOnce([
      {
        clientId: "client_abc",
        platform: "web",
        deviceName: null,
        appVersion: "1.9.2",
        trustLevel: "low",
        capabilities: JSON.stringify({ clipboard: true }),
        capabilitySource: "unknown",
        publicKey: "public-key",
        signingSecretEncrypted: "secret",
        deviceFingerprintVersion: "v1",
        createdAt: new Date(),
        lastSeenAt: new Date(),
        revokedAt,
        hybridKemPublicKey: "vault-kem-public",
        hybridKemSuiteId: "vault-xwing-mldsa65-v1",
        vaultSigningP256PublicKey: "vault-p256-public",
        vaultSigningMLDSA65PublicKey: "vault-mldsa65-public",
        vaultSigningSuiteId: "vault-xwing-mldsa65-v1",
      },
    ]);

    const clients = await listUserClients({
      userId: 10,
      currentClientId: "client_abc",
    });
    expect(clients[0]).toMatchObject({
      clientId: "client_abc",
      isCurrentClient: true,
      revokedAt,
      capabilities: { clipboard: true },
      vaultKeyDistribution: {
        suiteId: "vault-xwing-mldsa65-v1",
        keyGeneration: 1,
        kemPublicKey: "vault-kem-public",
        p256PublicKey: "vault-p256-public",
        mlDSA65PublicKey: "vault-mldsa65-public",
      },
    });
    expect(clients[0].signingSecretEncrypted).toBeUndefined();
    expect(clients[0].publicKey).toBeUndefined();
    expect(clients[0].deviceFingerprintVersion).toBeUndefined();
  });

  it("revokes owned clients and all other active clients", async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 1,
      userId: 10,
      clientId: "client_old",
      revokedAt: null,
    });
    const result = await revokeClient({ userId: 10, clientId: "client_old" });
    expect(result.revoked).toBe(true);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 10,
          clientId: "client_old",
          revokedAt: null,
        }),
      })
    );

    await revokeAllOtherClients({
      userId: 10,
      currentClientId: "client_current",
    });
    expect(mockUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 10,
          clientId: { not: "client_current" },
          revokedAt: null,
        }),
      })
    );
  });

  it("records trust checkpoints with only allowed client audit fields", async () => {
    const request = requestDouble({
      headers: {
        "X-Athena-Client-Id": "client_abc",
        "X-Athena-Platform": "web",
        "X-Athena-App-Version": "1.9.2",
        "X-Athena-Request-Id": "req_1",
        Authorization: "Bearer secret-token",
      },
    });
    getClientContext(request, { user: { id: 10 } });

    await recordClientTrustCheckpoint(request, {
      action: "workspace_delete",
      resourceType: "workspace",
      resourceId: "workspace-secret-slug",
      metadata: {
        token: "secret-token",
        publicKey: "public-key",
        deviceFingerprint: "fingerprint",
        safeField: "safe",
      },
    });

    const [event, metadata, userId] = mockLogEvent.mock.calls[0];
    expect(event).toBe("client_trust_checkpoint");
    expect(userId).toBe(10);
    expect(metadata).toMatchObject({
      action: "workspace_delete",
      resourceType: "workspace",
      clientId: "client_abc",
      platform: "web",
      trustLevel: "low",
      appVersion: "1.9.2",
      requestId: "req_1",
      layoutMode: null,
      inputMode: null,
      surface: null,
    });
    expect(metadata.resourceIdHash).toHaveLength(16);
    expect(metadata.safeField).toBe("safe");
    expect(metadata.publicKey).toBeUndefined();
    expect(metadata.deviceFingerprint).toBeUndefined();
    expect(metadata.token).toBeUndefined();
    expect(metadata.Authorization).toBeUndefined();
    expect(metadata.secret).toBeUndefined();
  });

  it("middleware attaches low trust context without blocking", () => {
    const request = requestDouble({
      headers: { "X-Athena-Client-Id": "client_mid" },
    });
    const next = jest.fn();
    clientIdentityMiddleware(request, {}, next);
    expect(next).toHaveBeenCalled();
    expect(request.clientContext.clientId).toBe("client_mid");
  });

  it("maps trust levels by platform", () => {
    expect(resolveTrustLevel("web")).toBe("low");
    expect(resolveTrustLevel("desktop")).toBe("medium");
    expect(resolveTrustLevel("ipad")).toBe("medium");
    expect(resolveTrustLevel("ios")).toBe("medium");
    expect(resolveTrustLevel("android")).toBe("medium");
    expect(resolveTrustLevel("api")).toBe("low");
    expect(resolveTrustLevel("web", { verified: true })).toBe("high");
  });
});
