const mockVaultEnvelopeModel = {
  findUnique: jest.fn(),
  findFirst: jest.fn(),
  count: jest.fn(),
  create: jest.fn(),
};
const mockVaultEpochModel = {
  findUnique: jest.fn(),
  findFirst: jest.fn(),
  findMany: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  updateMany: jest.fn(),
};
const mockVaultAckModel = {
  upsert: jest.fn(),
  count: jest.fn(),
};
const mockVaultRecoveryModel = {
  findFirst: jest.fn(),
  upsert: jest.fn(),
  update: jest.fn(),
  updateMany: jest.fn(),
};
const mockAthenaClientModel = {
  findFirst: jest.fn(),
  findMany: jest.fn(),
  count: jest.fn(),
};
const mockDeviceRegistrationModel = {
  findUnique: jest.fn(),
  findFirst: jest.fn(),
  findMany: jest.fn(),
};
const mockUserRootEpochModel = {
  findUnique: jest.fn(),
  findFirst: jest.fn(),
  create: jest.fn(),
};
const mockUserRootEnvelopeModel = {
  findUnique: jest.fn(),
  findFirst: jest.fn(),
  findMany: jest.fn(),
  count: jest.fn(),
  create: jest.fn(),
  updateMany: jest.fn(),
};
const mockUserRootChallengeModel = {
  count: jest.fn(),
  create: jest.fn(),
  updateMany: jest.fn(),
};

const mockPrisma = {
  $transaction: jest.fn(async (callback) =>
    callback({
      vault_device_key_envelopes: mockVaultEnvelopeModel,
      vault_key_epochs: mockVaultEpochModel,
      vault_epoch_acknowledgements: mockVaultAckModel,
      vault_recovery_packages: mockVaultRecoveryModel,
      vault_device_key_registrations: mockDeviceRegistrationModel,
      athena_clients: mockAthenaClientModel,
    })
  ),
  vault_key_epochs: mockVaultEpochModel,
  vault_recovery_packages: mockVaultRecoveryModel,
  vault_device_key_registrations: mockDeviceRegistrationModel,
};

jest.mock("../../utils/prisma", () => mockPrisma);
jest.mock("../../utils/authPrisma", () => ({
  $transaction: jest.fn(async (callback) =>
    callback({
      user_root_key_epochs: mockUserRootEpochModel,
      user_root_key_envelopes: mockUserRootEnvelopeModel,
      user_root_key_challenges: mockUserRootChallengeModel,
    })
  ),
  user_root_key_epochs: mockUserRootEpochModel,
  user_root_key_envelopes: mockUserRootEnvelopeModel,
  user_root_key_challenges: mockUserRootChallengeModel,
}));
jest.mock("../../models/vaultItem", () => ({
  VaultItem: {
    list: jest.fn(),
    get: jest.fn(),
    createOrUpdate: jest.fn(),
    delete: jest.fn(),
  },
}));

const { VaultRepository } = require("../../repositories/vaultRepository");

describe("VaultRepository device key epochs", () => {
  const request = {
    userId: 10,
    sourceClientId: "source-device",
    targetClientId: "target-device",
    keyEpoch: 4,
    envelope: { version: "athena-vault-key-envelope:v1", ciphertext: "abc" },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockVaultEnvelopeModel.findUnique.mockResolvedValue(null);
    mockVaultEnvelopeModel.findFirst.mockResolvedValue(null);
    mockVaultEnvelopeModel.count.mockResolvedValue(0);
    mockVaultEnvelopeModel.create.mockImplementation(async ({ data }) => data);
    mockVaultEpochModel.findUnique.mockResolvedValue({
      id: "vkepoch_4",
      keyEpoch: request.keyEpoch,
      status: "active",
    });
    mockVaultEpochModel.findFirst.mockResolvedValue(null);
    mockVaultEpochModel.create.mockImplementation(async ({ data }) => data);
    mockVaultEpochModel.update.mockImplementation(async ({ data }) => data);
    mockVaultEpochModel.updateMany.mockResolvedValue({ count: 1 });
    mockVaultAckModel.upsert.mockImplementation(async ({ create }) => create);
    mockVaultAckModel.count.mockResolvedValue(1);
    mockVaultRecoveryModel.findFirst.mockResolvedValue(null);
    mockDeviceRegistrationModel.findFirst.mockResolvedValue(null);
    mockDeviceRegistrationModel.findMany.mockResolvedValue([]);
    mockAthenaClientModel.findFirst.mockResolvedValue({
      clientId: request.targetClientId,
      vaultKeyGeneration: 1,
    });
    mockAthenaClientModel.count.mockResolvedValue(1);
    mockAthenaClientModel.findMany.mockResolvedValue([
      { clientId: "target-device" },
    ]);
    mockUserRootEpochModel.findUnique.mockResolvedValue(null);
    mockUserRootEpochModel.findFirst.mockResolvedValue(null);
    mockUserRootEpochModel.create.mockImplementation(async ({ data }) => data);
    mockUserRootEnvelopeModel.findUnique.mockResolvedValue(null);
    mockUserRootEnvelopeModel.findFirst.mockResolvedValue(null);
    mockUserRootEnvelopeModel.findMany.mockResolvedValue([]);
    mockUserRootEnvelopeModel.count.mockResolvedValue(0);
    mockUserRootEnvelopeModel.create.mockImplementation(
      async ({ data }) => data
    );
    mockUserRootEnvelopeModel.updateMany.mockResolvedValue({ count: 1 });
    mockUserRootChallengeModel.create.mockImplementation(
      async ({ data }) => data
    );
    mockUserRootChallengeModel.count.mockResolvedValue(0);
    mockUserRootChallengeModel.updateMany.mockResolvedValue({ count: 1 });
  });

  test("accepts an identical retry without writing a second envelope", async () => {
    const existing = {
      id: "vke_existing",
      userId: request.userId,
      sourceClientId: request.sourceClientId,
      targetClientId: request.targetClientId,
      keyEpoch: request.keyEpoch,
      envelopeJson: JSON.stringify(request.envelope),
    };
    mockVaultEnvelopeModel.findUnique.mockResolvedValue(existing);

    await expect(
      VaultRepository.storeDeviceKeyEnvelope(request)
    ).resolves.toEqual(existing);
    expect(mockVaultEnvelopeModel.create).not.toHaveBeenCalled();
  });

  test("rejects a different envelope at an already occupied epoch", async () => {
    mockVaultEnvelopeModel.findUnique.mockResolvedValue({
      sourceClientId: request.sourceClientId,
      envelopeJson: JSON.stringify({ ciphertext: "different" }),
    });

    await expect(
      VaultRepository.storeDeviceKeyEnvelope(request)
    ).rejects.toThrow("vault_key_epoch_conflict");
    expect(mockVaultEnvelopeModel.create).not.toHaveBeenCalled();
  });

  test("rejects rollback below the latest accepted epoch", async () => {
    mockVaultEnvelopeModel.findFirst.mockResolvedValue({ keyEpoch: 5 });

    await expect(
      VaultRepository.storeDeviceKeyEnvelope(request)
    ).rejects.toThrow("vault_key_epoch_stale");
    expect(mockVaultEnvelopeModel.create).not.toHaveBeenCalled();
  });

  test("stores the next monotonic epoch", async () => {
    mockVaultEnvelopeModel.findFirst.mockResolvedValue({ keyEpoch: 3 });

    const stored = await VaultRepository.storeDeviceKeyEnvelope(request);

    expect(stored).toMatchObject({
      userId: request.userId,
      sourceClientId: request.sourceClientId,
      targetClientId: request.targetClientId,
      keyEpoch: request.keyEpoch,
      envelopeJson: JSON.stringify(request.envelope),
    });
    expect(mockVaultEnvelopeModel.create).toHaveBeenCalledTimes(1);
  });

  test("rate limits a source that attempts to occupy epochs continuously", async () => {
    mockVaultEnvelopeModel.count.mockResolvedValue(120);
    await expect(
      VaultRepository.storeDeviceKeyEnvelope(request)
    ).rejects.toThrow("vault_key_epoch_rate_limited");
  });

  test("backfills a legacy envelope epoch before starting the next rotation", async () => {
    mockVaultEpochModel.findFirst.mockResolvedValue(null);
    mockVaultEnvelopeModel.findFirst.mockResolvedValue({
      keyEpoch: 7,
      sourceClientId: "legacy-device",
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const result = await VaultRepository.beginKeyEpochRotation({
      userId: 10,
      clientId: "source-device",
    });

    expect(result).toMatchObject({ keyEpoch: 8, status: "staging" });
    expect(mockVaultEpochModel.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({ keyEpoch: 7, status: "active" }),
      })
    );
  });

  test("activates an epoch only after every active device acknowledged it", async () => {
    mockVaultEpochModel.findUnique.mockResolvedValue({
      id: "vkepoch_4",
      keyEpoch: 4,
      status: "staging",
    });
    mockAthenaClientModel.findMany.mockResolvedValue([
      { clientId: "source-device" },
      { clientId: "target-device" },
    ]);
    mockVaultAckModel.count.mockResolvedValue(2);

    const result = await VaultRepository.acknowledgeKeyEpoch({
      userId: 10,
      clientId: "target-device",
      keyEpoch: 4,
      keyGeneration: 1,
      inventoryHash: "a".repeat(64),
    });

    expect(result).toMatchObject({ activeDevices: 2, acknowledgements: 2 });
    expect(mockVaultEpochModel.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "retiring" }),
      })
    );
    expect(mockVaultEpochModel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "active" }),
      })
    );
  });

  test("refuses epoch retirement until recovery and device coverage are complete", async () => {
    mockVaultEpochModel.findUnique.mockResolvedValue({
      id: "vkepoch_3",
      keyEpoch: 3,
      status: "retiring",
    });
    mockVaultEpochModel.findFirst.mockResolvedValue({
      id: "vkepoch_4",
      keyEpoch: 4,
      status: "active",
    });
    mockAthenaClientModel.findMany.mockResolvedValue([
      { clientId: "source-device" },
      { clientId: "target-device" },
    ]);
    mockVaultAckModel.count.mockResolvedValue(2);
    mockVaultRecoveryModel.findFirst.mockResolvedValue(null);

    await expect(
      VaultRepository.retireKeyEpoch({ userId: 10, keyEpoch: 3 })
    ).rejects.toThrow("vault_recovery_package_required");

    mockVaultRecoveryModel.findFirst.mockResolvedValue({
      recoveryKeyId: "recovery_device_1234",
      keyEpoch: 4,
    });
    await expect(
      VaultRepository.retireKeyEpoch({ userId: 10, keyEpoch: 3 })
    ).resolves.toMatchObject({ status: "retired" });
  });

  test("stores only a structurally valid opaque recovery package", async () => {
    mockVaultRecoveryModel.upsert.mockImplementation(
      async ({ create }) => create
    );
    const encryptedPackage = {
      version: "athena-vault-recovery-package:v1",
      recoveryKeyId: "recovery_device_1234",
      highestKeyEpoch: 4,
      salt: "A".repeat(43),
      sealedEpochMaterials: "B".repeat(64),
    };
    await expect(
      VaultRepository.storeRecoveryPackage({
        userId: 10,
        clientId: "source-device",
        recoveryKeyId: encryptedPackage.recoveryKeyId,
        keyEpoch: 4,
        suiteId: "vault-xwing-mldsa65-v1",
        encryptedPackage,
      })
    ).resolves.toMatchObject({ keyEpoch: 4 });
    await expect(
      VaultRepository.storeRecoveryPackage({
        userId: 10,
        clientId: "source-device",
        recoveryKeyId: encryptedPackage.recoveryKeyId,
        keyEpoch: 5,
        suiteId: "vault-xwing-mldsa65-v1",
        encryptedPackage,
      })
    ).rejects.toThrow("vault_recovery_package_invalid");
  });

  test("issues a bounded initialization challenge in shared auth", async () => {
    const result = await VaultRepository.issueUserRootChallenge({
      authUserId: 42,
      sourceClientId: "source-device",
      targetClientId: "source-device",
      purpose: "initialize",
    });

    expect(result).toMatchObject({
      purpose: "initialize",
      targetClientId: "source-device",
      rootEpoch: 1,
      rootKeyId: null,
    });
    expect(Buffer.from(result.challenge, "base64url")).toHaveLength(32);
    expect(result.challengeHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("rate limits User Root challenges per signed source device", async () => {
    mockUserRootChallengeModel.count.mockResolvedValue(30);

    await expect(
      VaultRepository.issueUserRootChallenge({
        authUserId: 42,
        sourceClientId: "source-device",
        targetClientId: "source-device",
        purpose: "initialize",
      })
    ).rejects.toThrow("user_root_challenge_rate_limited");
    expect(mockUserRootChallengeModel.create).not.toHaveBeenCalled();
  });

  test("initializes exactly one root epoch and stores only its opaque envelope", async () => {
    const envelope = {
      version: "athena-user-root-key-envelope:v2",
      materialType: "user-root-key",
      derivationSuiteId: "user-root-hkdf-sha256-v1",
      transportSuiteId: "vault-xwing-mldsa65-v1",
      authUserId: 42,
      sourceClientId: "source-device",
      targetClientId: "source-device",
      sourceKeyGeneration: 1,
      targetKeyGeneration: 1,
      targetKEMPublicKey: "K".repeat(64),
      rootEpoch: 1,
      rootKeyId: "R".repeat(43),
      challengeId: "urkchallenge_1",
      challenge: userRootChallenge,
      challengeSHA256: userRootChallengeHash,
      encapsulatedKey: "E".repeat(128),
      sealedRootKey: "S".repeat(256),
      p256PublicKey: "P".repeat(64),
      p256Signature: "I".repeat(86),
      mlDSA65PublicKey: "M".repeat(128),
      mlDSA65Signature: "Q".repeat(256),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };

    const result = await VaultRepository.initializeUserRoot({
      authUserId: 42,
      sourceClientId: "source-device",
      targetClientId: "source-device",
      sourceKeyGeneration: 1,
      targetKeyGeneration: 1,
      rootEpoch: 1,
      challengeId: envelope.challengeId,
      envelope,
    });

    expect(result.initialized).toBe(true);
    expect(result.epoch).toMatchObject({
      authUserId: 42,
      rootEpoch: 1,
      rootKeyId: envelope.rootKeyId,
    });
    expect(mockUserRootChallengeModel.updateMany).toHaveBeenCalledTimes(1);
    expect(mockUserRootEnvelopeModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          authUserId: 42,
          envelopeJson: JSON.stringify(envelope),
          consumedAt: expect.any(Date),
        }),
      })
    );
  });

  test("treats an already consumed Root envelope as an idempotent retry", async () => {
    mockUserRootEnvelopeModel.updateMany.mockResolvedValue({ count: 0 });
    mockUserRootEnvelopeModel.findFirst.mockResolvedValue({
      id: "urkenvelope_consumed",
    });

    await expect(
      VaultRepository.consumeUserRootEnvelope({
        authUserId: 42,
        targetClientId: "target-device",
        targetKeyGeneration: 1,
        envelopeId: "urkenvelope_consumed",
      })
    ).resolves.toBe(true);
  });

  test("rejects an authorization envelope for a different root commitment", async () => {
    mockUserRootEpochModel.findUnique.mockResolvedValue({
      authUserId: 42,
      rootEpoch: 1,
      rootKeyId: "A".repeat(43),
      derivationSuiteId: "user-root-hkdf-sha256-v1",
      transportSuiteId: "vault-xwing-mldsa65-v1",
      status: "active",
    });
    const envelope = {
      version: "athena-user-root-key-envelope:v2",
      materialType: "user-root-key",
      derivationSuiteId: "user-root-hkdf-sha256-v1",
      transportSuiteId: "vault-xwing-mldsa65-v1",
      authUserId: 42,
      sourceClientId: "source-device",
      targetClientId: "target-device",
      sourceKeyGeneration: 1,
      targetKeyGeneration: 1,
      rootEpoch: 1,
      rootKeyId: "B".repeat(43),
      challengeId: "urkchallenge_2",
      challenge: userRootChallenge,
      challengeSHA256: userRootChallengeHash,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      padding: "X".repeat(512),
    };

    await expect(
      VaultRepository.storeUserRootEnvelope({
        authUserId: 42,
        sourceClientId: "source-device",
        targetClientId: "target-device",
        sourceKeyGeneration: 1,
        targetKeyGeneration: 1,
        rootEpoch: 1,
        challengeId: envelope.challengeId,
        envelope,
      })
    ).rejects.toThrow("user_root_epoch_mismatch");
    expect(mockUserRootEnvelopeModel.create).not.toHaveBeenCalled();
  });

  test("does not list Root targets for a source device without a consumed envelope", async () => {
    mockUserRootEpochModel.findFirst.mockResolvedValue({
      authUserId: 42,
      rootEpoch: 1,
      rootKeyId: "R".repeat(43),
      status: "active",
    });
    mockDeviceRegistrationModel.findFirst.mockResolvedValue({
      clientId: "source-device",
      keyGeneration: 1,
      status: "active",
      revokedAt: null,
    });
    mockUserRootEnvelopeModel.findFirst.mockResolvedValue(null);

    await expect(
      VaultRepository.listUserRootAuthorizationTargets({
        userId: 10,
        authUserId: 42,
        sourceClientId: "source-device",
      })
    ).rejects.toThrow("user_root_source_device_not_authorized");
    expect(mockDeviceRegistrationModel.findMany).not.toHaveBeenCalled();
  });

  test("lists only the latest active Root targets not already covered", async () => {
    mockUserRootEpochModel.findFirst.mockResolvedValue({
      authUserId: 42,
      rootEpoch: 1,
      rootKeyId: "R".repeat(43),
      status: "active",
    });
    mockDeviceRegistrationModel.findFirst.mockResolvedValue({
      clientId: "source-device",
      keyGeneration: 1,
      status: "active",
      revokedAt: null,
    });
    mockUserRootEnvelopeModel.findFirst.mockResolvedValue({
      id: "source-consumed-envelope",
    });
    mockDeviceRegistrationModel.findMany.mockResolvedValue([
      { clientId: "covered-device", keyGeneration: 2 },
      { clientId: "target-device", keyGeneration: 3 },
      { clientId: "target-device", keyGeneration: 2 },
    ]);
    mockUserRootEnvelopeModel.findMany.mockResolvedValue([
      { targetClientId: "covered-device", targetKeyGeneration: 2 },
    ]);

    await expect(
      VaultRepository.listUserRootAuthorizationTargets({
        userId: 10,
        authUserId: 42,
        sourceClientId: "source-device",
      })
    ).resolves.toEqual([
      { clientId: "target-device", keyGeneration: 3 },
    ]);
  });
});
const crypto = require("crypto");

const userRootChallenge = Buffer.alloc(32, 7).toString("base64url");
const userRootChallengeHash = crypto
  .createHash("sha256")
  .update(Buffer.from(userRootChallenge, "base64url"))
  .digest("base64url");
