/* global jest, describe, beforeEach, test, expect */

const mockChallengeCreate = jest.fn();
const mockChallengeFindUnique = jest.fn();
const mockChallengeUpdate = jest.fn();
const mockChallengeUpdateMany = jest.fn();
const mockChallengeDeleteMany = jest.fn();
const mockTransaction = jest.fn();
const mockTxChallengeUpdateMany = jest.fn();
const mockTxClientUpdateMany = jest.fn();
const mockTxSessionUpdateMany = jest.fn();
const mockGetClientRecord = jest.fn();
const mockRecoverClientDeviceIdentity = jest.fn();
const mockRegisterClient = jest.fn();
const mockEmitSemanticEvent = jest.fn();

jest.mock("../../utils/authPrisma", () => ({
  auth_device_recovery_challenges: {
    create: mockChallengeCreate,
    findUnique: mockChallengeFindUnique,
    update: mockChallengeUpdate,
    updateMany: mockChallengeUpdateMany,
    deleteMany: mockChallengeDeleteMany,
  },
  athena_clients: { updateMany: jest.fn() },
  recovery_codes: { findMany: jest.fn() },
  $transaction: mockTransaction,
}));

jest.mock("../../utils/clientIdentity", () => ({
  getClientContext: () => ({
    clientId: "client-web",
    platform: "web",
    appVersion: "2.5",
    trustLevel: "medium",
    capabilities: {},
    capabilitySource: "header",
    legacy: false,
  }),
  getClientRecord: mockGetClientRecord,
  recoverClientDeviceIdentity: mockRecoverClientDeviceIdentity,
  recordClientNodeChange: jest.fn(),
  registerClient: mockRegisterClient,
}));

jest.mock("../../utils/requestSigning", () => ({
  canonicalPublicKey: (value) => value,
  verifyDeviceSignature: () => true,
}));

jest.mock("../../utils/security/cryptoSuiteRegistry", () => ({
  PURPOSES: { DEVICE_KEY: "device", REQUEST_SIGNATURE: "request" },
  SUITE_IDS: {
    DEVICE_P256_WEBCRYPTO_V1: "device-p256-webcrypto-v1",
    REQUEST_DEVICE_MLDSA65_V1: "request-device-mldsa65-v1",
  },
  cryptoSuite: () => ({}),
  keyMetadataForSuite: () => ({ algorithm: "ECDSA", parameterSet: "P-256" }),
  verifyWithCryptoSuite: () => true,
}));

jest.mock("../../utils/security/postQuantumKeyEncoding", () => ({
  mlDSA65PublicKey: (value) => value,
}));

jest.mock("../../utils/observability/semanticEvents", () => ({
  emitSemanticEvent: mockEmitSemanticEvent,
}));

const {
  canonicalProof,
  completeDeviceBindingRecovery,
  evaluateDeviceBindingForLogin,
  issueDeviceBindingChallenge,
  _deviceBindingInternals,
} = require("../../utils/authz/deviceBindingRecovery");

describe("device binding login preflight", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockChallengeDeleteMany.mockResolvedValue({ count: 0 });
    mockChallengeCreate.mockResolvedValue({ id: "challenge" });
    mockChallengeUpdate.mockResolvedValue({ id: "challenge" });
    mockChallengeUpdateMany.mockResolvedValue({ count: 1 });
    mockTxChallengeUpdateMany.mockResolvedValue({ count: 1 });
    mockTxClientUpdateMany.mockResolvedValue({ count: 1 });
    mockTxSessionUpdateMany.mockResolvedValue({ count: 1 });
    mockRecoverClientDeviceIdentity.mockResolvedValue({ id: 100 });
    mockTransaction.mockImplementation(async (callback) =>
      callback({
        auth_device_recovery_challenges: {
          updateMany: mockTxChallengeUpdateMany,
        },
        athena_clients: { updateMany: mockTxClientUpdateMany },
        auth_sessions: { updateMany: mockTxSessionUpdateMany },
      })
    );
  });

  test("stores only the challenge hash while returning the one-time value", async () => {
    const issued = await issueDeviceBindingChallenge({});
    expect(issued.challenge).toBeTruthy();
    expect(issued.challengeId).toMatch(/^dbr_/);
    const saved = mockChallengeCreate.mock.calls[0][0].data;
    expect(saved.challengeHash).toBe(
      _deviceBindingInternals.hash(issued.challenge)
    );
    expect(saved).not.toHaveProperty("challenge");
    expect(saved).not.toHaveProperty("privateKey");
  });

  test("returns a restricted recovery action instead of a full login on key mismatch", async () => {
    const challenge = "challenge-value";
    mockChallengeFindUnique.mockResolvedValue({
      id: "challenge-1",
      challengeHash: _deviceBindingInternals.hash(challenge),
      clientId: "client-web",
      status: "issued",
      expiresAt: new Date(Date.now() + 60_000),
    });
    mockGetClientRecord.mockResolvedValue({
      publicKey: "old-p256",
      pqPublicKey: "old-mldsa",
      revokedAt: null,
    });

    const result = await evaluateDeviceBindingForLogin({
      request: {},
      user: { id: 10 },
      authUser: { id: 20 },
      assertion: {
        challengeId: "challenge-1",
        challenge,
        p256: {
          publicKey: "new-p256",
          keyAlgorithm: "device-p256-webcrypto-v1",
          signature: "p256-proof",
        },
        postQuantum: {
          publicKey: "new-mldsa",
          signature: "mldsa-proof",
        },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      recoveryRequired: true,
      reasonCode: "device_key_mismatch",
    });
    expect(result.recoveryTicket).toBeTruthy();
    expect(mockRegisterClient).not.toHaveBeenCalled();
    expect(mockChallengeUpdate).toHaveBeenCalledWith({
      where: { id: "challenge-1" },
      data: expect.objectContaining({
        authUserId: 20,
        shadowUserId: 10,
        status: "recovery_required",
        recoveryTicketHash: _deviceBindingInternals.hash(
          result.recoveryTicket
        ),
      }),
    });
    expect(mockEmitSemanticEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "auth.device_binding.recovery_started",
      })
    );
  });

  test("uses the same canonical proof contract as the web client", () => {
    expect(
      canonicalProof({
        challengeId: "challenge-1",
        challenge: "secret",
        clientId: "client-web",
      })
    ).toBe(
      "athena-device-binding-preflight:v1\nchallenge-1\nsecret\nclient-web"
    );
  });

  test("claims a fresh proof and rebounds the owner-domain client before completing passkey recovery", async () => {
    const challenge = "fresh-challenge";
    mockChallengeFindUnique
      .mockResolvedValueOnce({
        id: "recovery-ticket-record",
        recoveryTicketHash: _deviceBindingInternals.hash("ticket"),
        clientId: "client-web",
        authUserId: 20,
        shadowUserId: 10,
        status: "recovery_required",
        expiresAt: new Date(Date.now() + 60_000),
      })
      .mockResolvedValueOnce({
        id: "fresh-proof-record",
        challengeHash: _deviceBindingInternals.hash(challenge),
        clientId: "client-web",
        status: "issued",
        expiresAt: new Date(Date.now() + 60_000),
      });

    await expect(
      completeDeviceBindingRecovery({
        request: {},
        user: { id: 10 },
        authUserId: 20,
        recoveryTicket: "ticket",
        assertion: {
          challengeId: "fresh-proof-record",
          challenge,
          p256: {
            publicKey: "new-p256",
            keyAlgorithm: "device-p256-webcrypto-v1",
            signature: "p256-proof",
          },
          postQuantum: {
            publicKey: "new-mldsa",
            signature: "mldsa-proof",
          },
        },
        method: "passkey",
      })
    ).resolves.toEqual({ success: true, recovered: true });

    expect(mockTxChallengeUpdateMany).toHaveBeenNthCalledWith(1, {
      where: expect.objectContaining({
        id: "recovery-ticket-record",
        status: "recovery_required",
        consumedAt: null,
      }),
      data: { status: "recovery_applying" },
    });
    expect(mockTxChallengeUpdateMany).toHaveBeenNthCalledWith(2, {
      where: expect.objectContaining({
        id: "fresh-proof-record",
        status: "issued",
        consumedAt: null,
      }),
      data: { status: "recovery_proof_applying" },
    });
    expect(mockRecoverClientDeviceIdentity).toHaveBeenCalledWith({
      userId: 10,
      clientId: "client-web",
      p256PublicKey: "new-p256",
      p256KeyAlgorithm: "device-p256-webcrypto-v1",
      pqPublicKey: "new-mldsa",
    });
    expect(mockTxChallengeUpdateMany).toHaveBeenNthCalledWith(3, {
      where: expect.objectContaining({
        id: "recovery-ticket-record",
        status: "recovery_applying",
        consumedAt: null,
      }),
      data: { status: "completed", consumedAt: expect.any(Date) },
    });
    expect(mockTxChallengeUpdateMany).toHaveBeenNthCalledWith(4, {
      where: expect.objectContaining({
        id: "fresh-proof-record",
        status: "recovery_proof_applying",
        consumedAt: null,
      }),
      data: { status: "completed", consumedAt: expect.any(Date) },
    });
  });

  test("releases both auth-domain claims when the owner-domain rebind fails", async () => {
    const challenge = "fresh-challenge";
    mockRecoverClientDeviceIdentity.mockResolvedValueOnce(null);
    mockChallengeFindUnique
      .mockResolvedValueOnce({
        id: "recovery-ticket-record",
        recoveryTicketHash: _deviceBindingInternals.hash("ticket"),
        clientId: "client-web",
        authUserId: 20,
        shadowUserId: 10,
        status: "recovery_required",
        expiresAt: new Date(Date.now() + 60_000),
      })
      .mockResolvedValueOnce({
        id: "fresh-proof-record",
        challengeHash: _deviceBindingInternals.hash(challenge),
        clientId: "client-web",
        status: "issued",
        expiresAt: new Date(Date.now() + 60_000),
      });

    await expect(
      completeDeviceBindingRecovery({
        request: {},
        user: { id: 10 },
        authUserId: 20,
        recoveryTicket: "ticket",
        assertion: {
          challengeId: "fresh-proof-record",
          challenge,
          p256: {
            publicKey: "new-p256",
            keyAlgorithm: "device-p256-webcrypto-v1",
            signature: "p256-proof",
          },
          postQuantum: {
            publicKey: "new-mldsa",
            signature: "mldsa-proof",
          },
        },
        method: "passkey",
      })
    ).rejects.toThrow("device_recovery_client_missing");

    expect(mockTxChallengeUpdateMany).toHaveBeenNthCalledWith(3, {
      where: {
        id: "recovery-ticket-record",
        status: "recovery_applying",
      },
      data: { status: "recovery_required" },
    });
    expect(mockTxChallengeUpdateMany).toHaveBeenNthCalledWith(4, {
      where: {
        id: "fresh-proof-record",
        status: "recovery_proof_applying",
      },
      data: { status: "issued" },
    });
  });
});
