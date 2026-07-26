const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const userRootChallenge = Buffer.alloc(32, 9).toString("base64url");
const userRootChallengeHash = crypto
  .createHash("sha256")
  .update(Buffer.from(userRootChallenge, "base64url"))
  .digest("base64url");

const mockLogEvent = jest.fn();
const mockUserGet = jest.fn();
const mockVaultGet = jest.fn();
const mockVaultList = jest.fn();
const mockVaultDelete = jest.fn();
const mockGetClientRecord = jest.fn();

jest.mock("../../models/eventLogs", () => ({
  EventLogs: {
    logEvent: (...args) => mockLogEvent(...args),
  },
}));

jest.mock("../../models/user", () => ({
  User: {
    _get: (...args) => mockUserGet(...args),
  },
}));

jest.mock("../../models/vaultItem", () => ({
  VaultItem: {
    list: (...args) => mockVaultList(...args),
    get: (...args) => mockVaultGet(...args),
    delete: (...args) => mockVaultDelete(...args),
    createOrUpdate: jest.fn(),
  },
}));

jest.mock("../../utils/middleware/validatedRequest", () => ({
  validatedRequest: (_request, _response, next) => next?.(),
}));

jest.mock("../../utils/clientIdentity", () => ({
  getClientContext: (request) => request.clientContext,
  getClientRecord: (...args) => mockGetClientRecord(...args),
}));

const {
  revokeVaultAccessGrants,
} = require("../../utils/authz/vaultAccessGrants");
const {
  validUserRootEnvelope,
  validVaultKeyEnvelope,
  vaultEndpoints,
} = require("../../endpoints/vault");
const { DataAccessCenter } = require("../../utils/dataAccess");

function routeRegistry() {
  const routes = {};
  const app = {};
  for (const method of ["get", "post", "put", "delete"]) {
    app[method] = (path, _middleware, handler) => {
      routes[`${method.toUpperCase()} ${path}`] = handler;
    };
  }
  vaultEndpoints(app);
  return routes;
}

function responseDouble() {
  return {
    locals: { user: { id: 10, authUserId: 42 } },
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
}

function requestDouble({ body = {}, vaultGrant = null } = {}) {
  const authorization = "Bearer active-session";
  return {
    body,
    params: { itemId: "vlt_1" },
    query: {},
    signedRequest: {
      ok: true,
      requestId: "req_1",
      signatureVersion: "v2-device-p256",
    },
    clientContext: {
      userId: 10,
      clientId: "client_abc",
      legacy: false,
      requestId: "req_1",
    },
    header(name) {
      if (name === "Authorization") return authorization;
      return name === "X-Athena-Vault-Grant" ? vaultGrant : null;
    },
    headers: {
      authorization,
      ...(vaultGrant ? { "x-athena-vault-grant": vaultGrant } : {}),
    },
  };
}

describe("vault security endpoints", () => {
  const originalGrantRequired = process.env.VAULT_GRANT_REQUIRED;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VAULT_GRANT_REQUIRED = "true";
    revokeVaultAccessGrants({ userId: 10 });
    mockLogEvent.mockResolvedValue({ eventLog: { id: 1 }, message: null });
    mockUserGet.mockResolvedValue({
      id: 10,
      password: bcrypt.hashSync("correct-password", 10),
    });
    mockVaultGet.mockResolvedValue({
      itemId: "vlt_1",
      itemType: "api_key",
      cryptoVersion: "athena-vault-item:v1",
      encryptedPayload: { ciphertext: "cipher" },
    });
    mockVaultList.mockResolvedValue([]);
    mockVaultDelete.mockResolvedValue(true);
  });

  afterAll(() => {
    if (originalGrantRequired === undefined)
      delete process.env.VAULT_GRANT_REQUIRED;
    else process.env.VAULT_GRANT_REQUIRED = originalGrantRequired;
  });

  it("blocks encrypted vault item reads without a fresh grant", async () => {
    const routes = routeRegistry();
    const response = responseDouble();

    await routes["GET /vault/items/:itemId"](requestDouble(), response);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: "vault_access_grant_required",
    });
    expect(mockVaultGet).not.toHaveBeenCalled();
  });

  it("binds a hybrid key envelope to both registered source signing keys", () => {
    const now = Date.now();
    const source = {
      clientId: "source-client",
      vaultSigningSuiteId: "vault-xwing-mldsa65-v1",
      vaultSigningP256PublicKey: "source-p256",
      vaultSigningMLDSA65PublicKey: "source-mldsa65",
      revokedAt: null,
    };
    const target = {
      clientId: "target-client",
      hybridKemSuiteId: "vault-xwing-mldsa65-v1",
      hybridKemPublicKey: "target-kem",
      revokedAt: null,
    };
    const envelope = {
      version: "athena-vault-key-envelope:v1",
      kemSuiteId: "vault-xwing-mldsa65-v1",
      sourceClientId: source.clientId,
      targetClientId: target.clientId,
      targetKEMPublicKey: target.hybridKemPublicKey,
      p256PublicKey: source.vaultSigningP256PublicKey,
      mlDSA65PublicKey: source.vaultSigningMLDSA65PublicKey,
      keyEpoch: 4,
      challengeSHA256: "A".repeat(43),
      createdAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    };

    expect(
      validVaultKeyEnvelope(envelope, { source, target, keyEpoch: 4 })
    ).toBe(true);
    expect(
      validVaultKeyEnvelope(
        { ...envelope, mlDSA65PublicKey: "attacker-key" },
        { source, target, keyEpoch: 4 }
      )
    ).toBe(false);
  });

  it("binds a User Root envelope to the shared identity and device generations", () => {
    const now = Date.now();
    const source = {
      clientId: "source-client",
      suiteId: "vault-xwing-mldsa65-v1",
      keyGeneration: 2,
      p256PublicKey: "source-p256",
      mlDSA65PublicKey: "source-mldsa",
      revokedAt: null,
    };
    const target = {
      clientId: "target-client",
      suiteId: "vault-xwing-mldsa65-v1",
      keyGeneration: 3,
      kemPublicKey: "target-kem",
      revokedAt: null,
    };
    const envelope = {
      version: "athena-user-root-key-envelope:v2",
      materialType: "user-root-key",
      derivationSuiteId: "user-root-hkdf-sha256-v1",
      transportSuiteId: "vault-xwing-mldsa65-v1",
      authUserId: 42,
      sourceClientId: source.clientId,
      targetClientId: target.clientId,
      sourceKeyGeneration: source.keyGeneration,
      targetKeyGeneration: target.keyGeneration,
      targetKEMPublicKey: target.kemPublicKey,
      rootEpoch: 1,
      rootKeyId: "R".repeat(43),
      challengeId: "urkchallenge_1",
      challenge: userRootChallenge,
      challengeSHA256: userRootChallengeHash,
      encapsulatedKey: "E".repeat(128),
      sealedRootKey: "S".repeat(256),
      p256PublicKey: source.p256PublicKey,
      p256Signature: "P".repeat(86),
      mlDSA65PublicKey: source.mlDSA65PublicKey,
      mlDSA65Signature: "M".repeat(256),
      createdAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    };

    expect(
      validUserRootEnvelope(envelope, {
        authUserId: 42,
        source,
        target,
        rootEpoch: 1,
      })
    ).toBe(true);
    expect(
      validUserRootEnvelope(
        { ...envelope, authUserId: 43 },
        { authUserId: 42, source, target, rootEpoch: 1 }
      )
    ).toBe(false);
    expect(
      validUserRootEnvelope(
        { ...envelope, targetKeyGeneration: 2 },
        { authUserId: 42, source, target, rootEpoch: 1 }
      )
    ).toBe(false);
    expect(
      validUserRootEnvelope(
        {
          ...envelope,
          challenge: Buffer.alloc(32, 10).toString("base64url"),
        },
        { authUserId: 42, source, target, rootEpoch: 1 }
      )
    ).toBe(false);
  });

  it("returns a conflict instead of reporting success for a stale Vault key epoch", async () => {
    const now = Date.now();
    const source = {
      clientId: "client_abc",
      vaultSigningSuiteId: "vault-xwing-mldsa65-v1",
      vaultSigningP256PublicKey: "source-p256",
      vaultSigningMLDSA65PublicKey: "source-mldsa65",
      revokedAt: null,
    };
    const target = {
      clientId: "target-client",
      hybridKemSuiteId: "vault-xwing-mldsa65-v1",
      hybridKemPublicKey: "target-kem",
      revokedAt: null,
    };
    mockGetClientRecord
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(target);
    const store = jest
      .spyOn(DataAccessCenter.vault, "storeDeviceKeyEnvelope")
      .mockRejectedValueOnce(new Error("vault_key_epoch_stale"));
    const registrations = jest
      .spyOn(DataAccessCenter.vault, "getDeviceKeyRegistration")
      .mockResolvedValue(null);
    const envelope = {
      version: "athena-vault-key-envelope:v1",
      kemSuiteId: "vault-xwing-mldsa65-v1",
      sourceClientId: source.clientId,
      targetClientId: target.clientId,
      targetKEMPublicKey: target.hybridKemPublicKey,
      p256PublicKey: source.vaultSigningP256PublicKey,
      mlDSA65PublicKey: source.vaultSigningMLDSA65PublicKey,
      keyEpoch: 4,
      challengeSHA256: "A".repeat(43),
      createdAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    };
    const request = requestDouble({
      body: { targetClientId: target.clientId, keyEpoch: 4, envelope },
    });
    request.signedRequest.postQuantumVerified = true;
    const response = responseDouble();

    await routeRegistry()["POST /vault/device-key-envelopes"](
      request,
      response
    );

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: "vault_key_epoch_stale",
    });
    store.mockRestore();
    registrations.mockRestore();
  });

  it("requires a post-quantum signed request before listing Root authorization targets", async () => {
    const listTargets = jest.spyOn(
      DataAccessCenter.vault,
      "listUserRootAuthorizationTargets"
    );
    const response = responseDouble();

    await routeRegistry()[
      "GET /vault/user-root-key/authorization-targets"
    ](requestDouble(), response);

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: "hybrid_signed_shared_identity_required",
    });
    expect(listTargets).not.toHaveBeenCalled();
    listTargets.mockRestore();
  });

  it("returns only public fields for uncovered Root authorization targets", async () => {
    const listTargets = jest
      .spyOn(DataAccessCenter.vault, "listUserRootAuthorizationTargets")
      .mockResolvedValue([
        {
          clientId: "target-device",
          keyGeneration: 2,
          suiteId: "vault-xwing-mldsa65-v1",
          kemPublicKey: "target-kem",
          p256PublicKey: "target-p256",
          mlDSA65PublicKey: "target-mldsa",
          privateKey: "must-not-leak",
          connectionId: "must-not-leak",
        },
      ]);
    const request = requestDouble();
    request.signedRequest.postQuantumVerified = true;
    const response = responseDouble();

    await routeRegistry()[
      "GET /vault/user-root-key/authorization-targets"
    ](request, response);

    expect(listTargets).toHaveBeenCalledWith({
      userId: 10,
      authUserId: 42,
      sourceClientId: "client_abc",
    });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({
      success: true,
      targets: [
        {
          clientId: "target-device",
          keyGeneration: 2,
          kemSuiteId: "vault-xwing-mldsa65-v1",
          kemPublicKey: "target-kem",
          p256PublicKey: "target-p256",
          mlDSA65PublicKey: "target-mldsa",
        },
      ],
    });
    listTargets.mockRestore();
  });

  it("issues a password-backed grant and allows the same client to read vault detail", async () => {
    const routes = routeRegistry();
    const grantResponse = responseDouble();

    await routes["POST /vault/reauth/password"](
      requestDouble({ body: { currentPassword: "correct-password" } }),
      grantResponse
    );

    const grantPayload = grantResponse.json.mock.calls[0][0];
    expect(grantResponse.status).toHaveBeenCalledWith(200);
    expect(grantPayload.vaultGrant).toBeTruthy();

    const readResponse = responseDouble();
    await routes["GET /vault/items/:itemId"](
      requestDouble({ vaultGrant: grantPayload.vaultGrant }),
      readResponse
    );

    expect(readResponse.status).toHaveBeenCalledWith(200);
    expect(readResponse.json).toHaveBeenCalledWith({
      success: true,
      item: expect.objectContaining({ itemId: "vlt_1" }),
    });
    expect(mockVaultGet).toHaveBeenCalledWith({
      userId: 10,
      itemId: "vlt_1",
      includeEncryptedPayload: true,
    });
  });

  it("does not allow password reauthentication for non-password credentials", async () => {
    mockUserGet.mockResolvedValue({
      id: 10,
      credentialType: "passkey_only",
      password: bcrypt.hashSync("correct-password", 10),
    });
    const response = responseDouble();

    await routeRegistry()["POST /vault/reauth/password"](
      requestDouble({ body: { currentPassword: "correct-password" } }),
      response
    );

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: "vault_reauth_failed",
    });
  });
});
