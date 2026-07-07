const mockGate = {
  getGateConfigStatus: jest.fn(),
  cryptoGateEventBuffer: {
    recent: jest.fn(),
  },
};
const mockHub = {
  cryptoDataHub: {
    getStatus: jest.fn(),
    getLoadingProgress: jest.fn(),
  },
};
const mockVaultItem = {
  list: jest.fn(),
  get: jest.fn(),
  createOrUpdate: jest.fn(),
  delete: jest.fn(),
};
const mockSensitiveSessions = {
  sensitiveSessionSnapshot: jest.fn(),
  revokeSensitiveSessions: jest.fn(),
};
const mockSystemSettings = {
  get: jest.fn(),
  getValueOrFallback: jest.fn(),
  where: jest.fn(),
  updateSettings: jest.fn(),
  delete: jest.fn(),
};
const mockEventLogs = {
  where: jest.fn(),
  count: jest.fn(),
  delete: jest.fn(),
};
const mockSystemPatrol = {
  status: jest.fn(),
  runSystemPatrol: jest.fn(),
  getRun: jest.fn(),
  previewRepair: jest.fn(),
  confirmRepair: jest.fn(),
};

jest.mock("../../utils/cryptoGate", () => mockGate);
jest.mock("../../utils/cryptoHub", () => mockHub);
jest.mock("../../models/vaultItem", () => ({ VaultItem: mockVaultItem }));
jest.mock("../../utils/authz/sensitiveSessions", () => mockSensitiveSessions);
jest.mock("../../models/systemSettings", () => ({
  SystemSettings: mockSystemSettings,
}));
jest.mock("../../repositories/eventLogRepository", () => ({
  EventLogRepository: mockEventLogs,
}));
jest.mock("../../utils/systemPatrol", () => mockSystemPatrol);
jest.mock("../../utils/environment", () => ({
  authDatabaseUrl: jest.fn(() => "file:/tmp/anythingllm/auth.db"),
  databasePath: jest.fn(() => "/tmp/anythingllm/anythingllm.db"),
  diagnosticSummary: jest.fn(() => ({
    storageRoot: "/tmp/anythingllm",
    paths: { documents: "/tmp/anythingllm/documents" },
  })),
}));

const { CryptoRepository } = require("../../repositories/cryptoRepository");
const { VaultRepository } = require("../../repositories/vaultRepository");
const {
  SensitiveDataRepository,
} = require("../../repositories/sensitiveDataRepository");
const {
  AdminSystemRepository,
} = require("../../repositories/adminSystemRepository");

describe("P2 data access repositories", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("crypto repository exposes status without credentials", () => {
    mockGate.getGateConfigStatus.mockReturnValue({
      enabled: true,
      hasApiKey: true,
      hasApiSecret: true,
      maskedApiKey: "abcd****wxyz",
    });
    mockHub.cryptoDataHub.getStatus.mockReturnValue({ status: "ready" });
    mockHub.cryptoDataHub.getLoadingProgress.mockReturnValue({ progress: 1 });
    mockGate.cryptoGateEventBuffer.recent.mockReturnValue([
      {
        event: "connected",
        sanitizedPayload: { apiSecret: "should-drop", symbol: "BTC_USDT" },
      },
    ]);

    const snapshot = CryptoRepository.snapshot();

    expect(snapshot.config).toMatchObject({
      hasApiKey: true,
      hasApiSecret: true,
      maskedApiKey: "abcd****wxyz",
    });
    expect(JSON.stringify(snapshot)).not.toContain("should-drop");
    expect(snapshot.recentEvents[0].sanitizedPayload.symbol).toBe("BTC_USDT");
  });

  test("vault repository returns encrypted envelope instead of plaintext", async () => {
    mockVaultItem.get.mockResolvedValueOnce({
      itemId: "vlt_1",
      itemType: "secret",
      label: "API key",
      keyId: "key-1",
      cryptoVersion: "v1",
      metadata: { provider: "demo", apiKey: "drop-me" },
      encryptedPayload: {
        cryptoVersion: "v1",
        algorithm: "AES-GCM",
        keyId: "key-1",
        wrappedItemKey: "wrapped",
        iv: "iv",
        ciphertext: "cipher",
      },
    });

    const item = await VaultRepository.getEnvelope({
      userId: 7,
      itemId: "vlt_1",
    });

    expect(item.encryptedPayload).toEqual({
      cryptoVersion: "v1",
      algorithm: "AES-GCM",
      keyId: "key-1",
      hasWrappedItemKey: true,
      hasIv: true,
      hasCiphertext: true,
    });
    expect(JSON.stringify(item)).not.toContain("drop-me");
    expect(JSON.stringify(item)).not.toContain("cipher");
  });

  test("vault repository keeps raw compatibility methods for migrated endpoints", async () => {
    mockVaultItem.get.mockResolvedValueOnce({
      itemId: "vlt_2",
      itemType: "secret",
      encryptedPayload: { ciphertext: "ciphertext-for-client" },
    });

    const item = await VaultRepository.getItem({
      userId: 7,
      itemId: "vlt_2",
      includeEncryptedPayload: true,
    });

    expect(mockVaultItem.get).toHaveBeenCalledWith({
      userId: 7,
      itemId: "vlt_2",
      includeEncryptedPayload: true,
    });
    expect(item.encryptedPayload.ciphertext).toBe("ciphertext-for-client");
  });

  test("sensitive repository classifies secret fields and returns redacted snapshots", () => {
    mockSensitiveSessions.sensitiveSessionSnapshot.mockReturnValue([
      { sessionId: "[redacted-sensitive-session]", resourceType: "reader" },
    ]);

    const classified = SensitiveDataRepository.classify({
      nested: { signingSecret: "secret" },
    });
    const snapshot = SensitiveDataRepository.snapshot({ userId: 7 });

    expect(classified.classification).toBe("secret");
    expect(classified.fields[0]).toMatchObject({
      path: "nested.signingSecret",
      classification: "secret",
    });
    expect(snapshot.sessions[0].sessionId).toBe("[redacted-sensitive-session]");
  });

  test("admin system repository redacts sensitive settings and event metadata", async () => {
    mockSystemSettings.get.mockResolvedValueOnce({
      label: "hub_api_key",
      value: "plain-secret",
    });
    mockEventLogs.where.mockResolvedValueOnce([
      { id: 1, event: "x", metadata: { token: "secret", ok: true } },
    ]);

    const setting = await AdminSystemRepository.getSetting({
      label: "hub_api_key",
    });
    const logs = await AdminSystemRepository.eventLogs({});

    expect(setting.value).toBe("[redacted]");
    expect(logs[0].metadata).toEqual({ ok: true });
  });
});
