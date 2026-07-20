const mockUserState = {
  where: jest.fn(),
  upsertMany: jest.fn(),
  delete: jest.fn(),
};
const mockSyncV2 = {
  canAccessNode: jest.fn(),
  mutationReplay: jest.fn(),
  batchGet: jest.fn(),
};
const mockMutationReceipt = {
  reserve: jest.fn(),
  complete: jest.fn(),
};
const mockDataAccess = {
  adminSystem: { user: { update: jest.fn() } },
  workspace: { update: jest.fn() },
  workspaceThread: { get: jest.fn(), update: jest.fn() },
  iosPushToken: {},
  syncEvent: {},
  syncV2: mockSyncV2,
  athenaMutationReceipt: mockMutationReceipt,
  userState: mockUserState,
};
const mockClassifyNodeKey = jest.fn();

jest.mock("../../utils/dataAccess", () => ({
  DataAccessCenter: mockDataAccess,
}));
jest.mock("../../utils/http", () => ({
  userFromSession: jest.fn(),
  reqBody: (request) => request.body || {},
  multiUserMode: jest.fn().mockReturnValue(true),
}));
jest.mock("../../utils/middleware/multiUserProtected", () => ({
  flexUserRoleValid: () => (_request, _response, next) => next(),
  ROLES: { all: "all" },
}));
jest.mock("../../utils/middleware/validatedRequest", () => ({
  validatedRequest: (_request, _response, next) => next(),
}));
jest.mock("../../utils/security/transportSecurity", () => ({
  setSseTransportHeaders: jest.fn(),
  ensureSecureWebSocketRequest: jest.fn(),
}));
jest.mock("../../utils/helpers/chat/responses", () => ({
  writeResponseChunk: jest.fn(),
}));
jest.mock("../../utils/syncCenter", () => ({
  subscribeToSyncEvents: jest.fn(),
  syncEventVisibleToUser: jest.fn(),
}));
jest.mock("../../utils/broadcast", () => ({
  broadcastCenter: {},
  subscribeToBroadcastEvents: jest.fn(),
}));
jest.mock("../../utils/clientIdentity", () => ({
  getClientContext: jest.fn(),
}));
jest.mock("../../utils/nativePush/apnsProvider", () => ({
  configuration: jest.fn().mockReturnValue({}),
}));
jest.mock("../../utils/requestSigning", () => ({
  verifySignedWebSocketMessage: jest.fn(),
  signingErrorCode: jest.fn(),
  signingWarnOnly: jest.fn(),
}));
jest.mock("../../utils/syncV2/config", () => ({
  syncV2Enabled: jest.fn().mockReturnValue(true),
  syncV2RetentionMs: jest.fn().mockReturnValue(30 * 24 * 60 * 60 * 1000),
}));
jest.mock("../../utils/syncV2/nodeRegistry", () => ({
  classifyNodeKey: (...args) => mockClassifyNodeKey(...args),
}));
jest.mock("../../utils/chats/threadChatModel", () => ({
  isSupportedThreadChatModel: jest.fn().mockReturnValue(true),
}));

const { __test } = require("../../endpoints/syncCenter");
const { mutationRequestHash } = require("../../utils/syncV2/mutationPolicy");

const context = {
  user: { id: 7, role: "default" },
  client: { clientId: "web-client" },
  allowAllWorkspaces: false,
};
const mutation = {
  mutationId: "intent-1",
  nodeKey: "users/7/preferences/ui/global",
  baseVersion: 4,
  operation: "merge",
  changedPaths: ["untrusted"],
  payload: { theme: "dark", dirty: true, updatedAt: "client-clock" },
};

describe("Sync V2 mutation protocol", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClassifyNodeKey.mockReturnValue({
      nodeKey: mutation.nodeKey,
      kind: "user-preferences",
      ownerType: "user",
      ownerId: 7,
      namespace: "ui",
      scope: "global",
    });
    mockSyncV2.canAccessNode.mockResolvedValue(true);
    mockUserState.where.mockResolvedValue([
      { version: "1", value: { language: "zh" } },
    ]);
    mockUserState.upsertMany.mockResolvedValue({ success: true });
    mockMutationReceipt.complete.mockResolvedValue({ status: "completed" });
  });

  test("replays an exact completed mutation without another domain write", async () => {
    mockMutationReceipt.reserve.mockResolvedValue({
      created: false,
      receipt: {
        status: "completed",
        requestHash: mutationRequestHash(mutation),
        result: { descriptor: { nodeKey: mutation.nodeKey, stateVersion: 5 } },
      },
    });

    await expect(
      __test.applySyncV2Mutation(context, mutation)
    ).resolves.toEqual(
      expect.objectContaining({
        replayed: true,
        descriptor: expect.objectContaining({ stateVersion: 5 }),
      })
    );
    expect(mockUserState.upsertMany).not.toHaveBeenCalled();
    expect(mockSyncV2.mutationReplay).not.toHaveBeenCalled();
  });

  test("rejects reuse of one mutation ID for different semantics", async () => {
    mockMutationReceipt.reserve.mockResolvedValue({
      created: false,
      receipt: {
        status: "completed",
        requestHash: mutationRequestHash({
          ...mutation,
          payload: { theme: "light" },
        }),
      },
    });

    await expect(
      __test.applySyncV2Mutation(context, mutation)
    ).rejects.toMatchObject({
      code: "sync_v2_idempotency_key_reused",
      httpStatus: 409,
    });
    expect(mockUserState.upsertMany).not.toHaveBeenCalled();
  });

  test("returns retryable 425 while an identical mutation is in flight", async () => {
    mockMutationReceipt.reserve.mockResolvedValue({
      created: false,
      receipt: {
        status: "pending",
        requestHash: mutationRequestHash(mutation),
        updatedAt: new Date(),
      },
    });
    mockSyncV2.mutationReplay.mockResolvedValue(null);

    await expect(
      __test.applySyncV2Mutation(context, mutation)
    ).rejects.toMatchObject({
      code: "sync_v2_mutation_in_progress",
      httpStatus: 425,
    });
    expect(mockUserState.upsertMany).not.toHaveBeenCalled();
  });

  test("applies a new mutation with server-derived paths and stores its result", async () => {
    mockUserState.upsertMany.mockResolvedValue([
      {
        namespace: "ui",
        scope: "global",
        version: "1",
        value: { theme: "dark" },
      },
    ]);
    mockMutationReceipt.reserve.mockResolvedValue({
      created: true,
      receipt: {
        status: "pending",
        requestHash: mutationRequestHash(mutation),
        updatedAt: new Date(),
      },
    });
    mockSyncV2.mutationReplay
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        event: { seq: 18 },
        descriptor: { nodeKey: mutation.nodeKey, stateVersion: 5 },
      });

    await expect(
      __test.applySyncV2Mutation(context, mutation)
    ).resolves.toMatchObject({
      replayed: false,
      descriptor: { stateVersion: 5 },
      projection: {
        namespace: "ui",
        scope: "global",
        schemaVersion: "1",
        value: { theme: "dark" },
      },
    });
    expect(mockUserState.upsertMany).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 7,
        states: [
          expect.objectContaining({
            mutationOperation: "merge",
            mutationPayload: { theme: "dark" },
            baseVersion: 4,
            changedPaths: ["theme"],
            mutationId: "intent-1",
          }),
        ],
      })
    );
    expect(mockMutationReceipt.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 7,
        resultVersion: 5,
      })
    );
  });
});
