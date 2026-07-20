const mockFindUnique = jest.fn();
const mockCreate = jest.fn();
const mockFindMany = jest.fn();
const mockTransaction = jest.fn();
const mockRecordNodeChange = jest.fn();
const mockSyncNodeFindUnique = jest.fn();

const mockTx = {
  athena_clients: {
    findUnique: (...args) => mockFindUnique(...args),
    create: (...args) => mockCreate(...args),
    findMany: (...args) => mockFindMany(...args),
  },
};

const mockClientFacade = {
  db: {
    $transaction: (...args) => mockTransaction(...args),
    sync_nodes: {
      findUnique: (...args) => mockSyncNodeFindUnique(...args),
    },
  },
};

const mockSyncFacade = {
  enabled: jest.fn().mockReturnValue(true),
  schemaReady: jest.fn().mockResolvedValue(true),
  recordNodeChange: (...args) => mockRecordNodeChange(...args),
};

jest.mock("../../utils/dataAccess/lazyFacade", () => ({
  lazyDataAccessFacade: (domain) =>
    domain === "clientIdentity" ? mockClientFacade : mockSyncFacade,
}));

jest.mock("../../repositories/eventLogRepository", () => ({
  EventLogRepository: { logEvent: jest.fn() },
}));

const { registerClient } = require("../../utils/clientIdentity");

describe("client identity Sync V2 transaction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSyncFacade.enabled.mockResolvedValue(true);
    mockSyncFacade.schemaReady.mockResolvedValue(true);
    mockFindUnique.mockResolvedValue(null);
    mockSyncNodeFindUnique.mockResolvedValue(null);
    mockCreate.mockResolvedValue({
      id: 11,
      userId: 7,
      clientId: "client-sync",
      platform: "web",
      createdAt: new Date("2026-07-17T12:00:00.000Z"),
      revokedAt: null,
    });
    mockFindMany.mockResolvedValue([]);
    mockRecordNodeChange.mockResolvedValue({
      node: { nodeKey: "users/7/security/clients", stateVersion: 2 },
      event: { seq: 20 },
    });
    mockTransaction.mockImplementation(async (callback) => callback(mockTx));
  });

  test("writes the client and outbox through the same transaction client", async () => {
    await registerClient({
      userId: 7,
      clientId: "client-sync",
      platform: "web",
      deviceName: "Browser",
    });

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockRecordNodeChange).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        nodeKey: "users/7/security/clients",
        eventType: "client.registered",
      })
    );
  });

  test("does not report a successful client write when outbox creation fails", async () => {
    mockRecordNodeChange.mockRejectedValueOnce(new Error("outbox_failed"));

    await expect(
      registerClient({
        userId: 7,
        clientId: "client-sync",
        platform: "web",
      })
    ).rejects.toThrow("outbox_failed");
  });

  test("does not append an outbox event when the security domain is disabled", async () => {
    mockSyncFacade.enabled.mockResolvedValueOnce(false);
    mockClientFacade.db.athena_clients = {
      findUnique: (...args) => mockFindUnique(...args),
      create: (...args) => mockCreate(...args),
    };

    await registerClient({
      userId: 7,
      clientId: "client-sync",
      platform: "web",
    });

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockRecordNodeChange).not.toHaveBeenCalled();
  });

  test("keeps an existing shadow security node current during device-key enrollment", async () => {
    mockSyncFacade.enabled.mockReturnValue(false);
    mockSyncNodeFindUnique.mockResolvedValue({
      nodeKey: "users/7/security/clients",
    });

    await registerClient({
      userId: 7,
      clientId: "client-sync",
      platform: "ios",
      publicKey: JSON.stringify({ kty: "EC", crv: "P-256" }),
      deviceFingerprintVersion: "p256-secure-enclave-v1",
    });

    expect(mockSyncNodeFindUnique).toHaveBeenCalledWith({
      where: { nodeKey: "users/7/security/clients" },
      select: { nodeKey: true },
    });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockRecordNodeChange).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        nodeKey: "users/7/security/clients",
        eventType: "client.registered",
      })
    );
  });
});
