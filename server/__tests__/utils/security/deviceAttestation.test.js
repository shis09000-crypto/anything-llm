const mockFindClient = jest.fn();
const mockFindChallenge = jest.fn();
const mockDeleteChallenges = jest.fn();
const mockCreateChallenge = jest.fn();
const mockConsumeChallenge = jest.fn();
const mockUpdateClient = jest.fn();
const mockSyncReady = jest.fn();
const mockRecordNodeChange = jest.fn();

const mockDb = {
  athena_clients: {
    findFirst: (...args) => mockFindClient(...args),
    updateMany: (...args) => mockUpdateClient(...args),
  },
  athena_device_attestation_challenges: {
    findUnique: (...args) => mockFindChallenge(...args),
    deleteMany: (...args) => mockDeleteChallenges(...args),
    create: (...args) => mockCreateChallenge(...args),
    updateMany: (...args) => mockConsumeChallenge(...args),
  },
  $transaction: jest.fn(async (callback) => callback(mockDb)),
};

jest.mock("../../../repositories/clientIdentityRepository", () => ({
  ClientIdentityRepository: { db: mockDb },
}));

jest.mock("../../../utils/clientIdentity", () => ({
  clientSecuritySyncReady: (...args) => mockSyncReady(...args),
  recordClientNodeChange: (...args) => mockRecordNodeChange(...args),
}));

jest.mock("../../../utils/security/serviceIdentity", () => ({
  loadServiceIdentity: jest.fn(),
}));

const {
  MAX_ATTESTATION_OBJECT_BYTES,
  completeDeviceAttestation,
  deviceKeyBindingHash,
  issueDeviceAttestationChallenge,
  validDeviceAttestation,
} = require("../../../utils/security/deviceAttestation");

const client = {
  id: 7,
  userId: 10,
  clientId: "ios-device-1",
  publicKey: "p256-public-key",
  publicKeyAlgorithm: "ECDSA",
  pqPublicKey: "mldsa65-public-key",
  pqKeyAlgorithm: "ML-DSA-65",
  hybridKemPublicKey: "xwing-public-key",
  hybridKemSuiteId: "vault-xwing-mldsa65-v1",
  vaultSigningP256PublicKey: "vault-p256-public-key",
  vaultSigningMLDSA65PublicKey: "vault-mldsa65-public-key",
  vaultSigningSuiteId: "vault-xwing-mldsa65-v1",
  revokedAt: null,
};

function responseFor(payload) {
  return {
    ok: true,
    headers: { get: () => null },
    text: async () => JSON.stringify(payload),
  };
}

describe("Apple App Attest device binding", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindClient.mockResolvedValue(client);
    mockDeleteChallenges.mockResolvedValue({ count: 0 });
    mockCreateChallenge.mockResolvedValue({ id: "att_created" });
    mockConsumeChallenge.mockResolvedValue({ count: 1 });
    mockUpdateClient.mockResolvedValue({ count: 1 });
    mockSyncReady.mockResolvedValue(true);
    mockRecordNodeChange.mockResolvedValue({ stateVersion: 2 });
  });

  test("issues a short-lived challenge bound to every device public key", async () => {
    const challenge = await issueDeviceAttestationChallenge({
      userId: 10,
      clientId: client.clientId,
    });

    expect(challenge.keyBindingHash).toBe(deviceKeyBindingHash(client));
    expect(challenge.verificationType).toBe("attestation");
    expect(challenge.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(mockCreateChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 10,
          clientId: client.clientId,
          keyBindingHash: challenge.keyBindingHash,
        }),
      })
    );
  });

  test("consumes a broker-verified challenge and updates Sync V2 atomically", async () => {
    const keyBindingHash = deviceKeyBindingHash(client);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    mockFindChallenge.mockResolvedValue({
      id: "att_1",
      userId: 10,
      clientId: client.clientId,
      status: "pending",
      keyBindingHash,
      clientDataHash: "client-data-hash",
      expiresAt,
    });
    const fetchImpl = jest.fn(async () =>
      responseFor({
        verified: true,
        keyId: "apple-key-1",
        appId: "TEAM.com.athena.app",
        environment: "development",
        clientDataHash: "client-data-hash",
        keyBindingHash,
        assertionCounter: 1,
        expiresAt,
      })
    );

    const result = await completeDeviceAttestation(
      {
        userId: 10,
        clientId: client.clientId,
        challengeId: "att_1",
        keyId: "apple-key-1",
        attestationObject: Buffer.from("attestation").toString("base64url"),
        appId: "TEAM.com.athena.app",
      },
      {
        env: {
          APP_ENV: "development",
          ATHENA_APP_ATTEST_APP_ID: "TEAM.com.athena.app",
          ATHENA_APP_ATTEST_VERIFIER_URL: "http://attestation.test/verify",
        },
        fetchImpl,
      }
    );

    expect(result).toMatchObject({ status: "verified", assertionCounter: 1 });
    expect(mockConsumeChallenge).toHaveBeenCalledTimes(1);
    expect(mockUpdateClient).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attestationStatus: "verified",
          attestationEnvironment: "development",
        }),
      })
    );
    expect(mockRecordNodeChange).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        eventType: "client.device_attestation_verified",
      })
    );
  });

  test("rejects wrong application identities before calling the broker", async () => {
    const fetchImpl = jest.fn();
    await expect(
      completeDeviceAttestation(
        {
          userId: 10,
          clientId: client.clientId,
          challengeId: "att_1",
          keyId: "apple-key-1",
          attestationObject: Buffer.from("attestation").toString("base64url"),
          appId: "ATTACKER.com.athena.app",
        },
        {
          env: {
            APP_ENV: "development",
            ATHENA_APP_ATTEST_APP_ID: "TEAM.com.athena.app",
            ATHENA_APP_ATTEST_VERIFIER_URL: "http://attestation.test/verify",
          },
          fetchImpl,
        }
      )
    ).rejects.toThrow("device_attestation_app_id_mismatch");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects oversized attestation objects and expired attestations", async () => {
    await expect(
      completeDeviceAttestation({
        userId: 10,
        clientId: client.clientId,
        challengeId: "att_1",
        keyId: "apple-key-1",
        attestationObject: Buffer.alloc(
          MAX_ATTESTATION_OBJECT_BYTES + 1,
          1
        ).toString("base64url"),
        appId: "TEAM.com.athena.app",
      })
    ).rejects.toThrow("device_attestation_payload_invalid");
    expect(
      validDeviceAttestation(
        {
          attestationStatus: "verified",
          attestationProvider: "apple-app-attest",
          attestationEnvironment: "production",
          attestationExpiresAt: new Date(Date.now() - 1).toISOString(),
        },
        { APP_ENV: "production" }
      )
    ).toBe(false);
  });

  test("requires a strictly increasing assertion counter", async () => {
    const boundClient = {
      ...client,
      attestationKeyIdHash: require("crypto")
        .createHash("sha256")
        .update("apple-key-1")
        .digest("base64url"),
      attestationCounter: 4,
    };
    const keyBindingHash = deviceKeyBindingHash(boundClient);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    mockFindClient.mockResolvedValue(boundClient);
    mockFindChallenge.mockResolvedValue({
      id: "att_assertion_1",
      userId: 10,
      clientId: client.clientId,
      status: "pending",
      keyBindingHash,
      clientDataHash: "client-data-hash",
      expiresAt,
    });

    await expect(
      completeDeviceAttestation(
        {
          userId: 10,
          clientId: client.clientId,
          challengeId: "att_assertion_1",
          keyId: "apple-key-1",
          assertionObject: Buffer.from("assertion").toString("base64url"),
          appId: "TEAM.com.athena.app",
        },
        {
          env: {
            APP_ENV: "development",
            ATHENA_APP_ATTEST_APP_ID: "TEAM.com.athena.app",
            ATHENA_APP_ATTEST_VERIFIER_URL: "http://attestation.test/verify",
          },
          fetchImpl: async () =>
            responseFor({
              verified: true,
              keyId: "apple-key-1",
              appId: "TEAM.com.athena.app",
              environment: "development",
              clientDataHash: "client-data-hash",
              keyBindingHash,
              assertionCounter: 4,
              expiresAt,
            }),
        }
      )
    ).rejects.toThrow("device_attestation_counter_not_advanced");
    expect(mockConsumeChallenge).not.toHaveBeenCalled();
  });

  test("returns the committed result when the verification response was lost", async () => {
    const now = Date.now();
    const keyHash = require("crypto")
      .createHash("sha256")
      .update("apple-key-1")
      .digest("base64url");
    const verifiedClient = {
      ...client,
      attestationProvider: "apple-app-attest",
      attestationKeyIdHash: keyHash,
      attestationStatus: "verified",
      attestationEnvironment: "development",
      attestationCounter: 3,
      attestedAt: new Date(now - 1_000),
      attestationExpiresAt: new Date(now + 60_000),
    };
    mockFindClient.mockResolvedValue(verifiedClient);
    mockFindChallenge.mockResolvedValue({
      id: "att_committed",
      userId: 10,
      clientId: client.clientId,
      status: "consumed",
      keyBindingHash: deviceKeyBindingHash(verifiedClient),
      clientDataHash: "client-data-hash",
      expiresAt: new Date(now + 10_000),
    });
    const fetchImpl = jest.fn();

    await expect(
      completeDeviceAttestation(
        {
          userId: 10,
          clientId: client.clientId,
          challengeId: "att_committed",
          keyId: "apple-key-1",
          assertionObject: Buffer.from("assertion").toString("base64url"),
          appId: "TEAM.com.athena.app",
        },
        {
          env: {
            APP_ENV: "development",
            ATHENA_APP_ATTEST_APP_ID: "TEAM.com.athena.app",
            ATHENA_APP_ATTEST_VERIFIER_URL: "http://attestation.test/verify",
          },
          fetchImpl,
        }
      )
    ).resolves.toMatchObject({
      status: "verified",
      assertionCounter: 3,
      idempotentReplay: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
