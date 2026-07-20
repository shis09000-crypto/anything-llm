const mockTransaction = jest.fn();
const mockPacketCreate = jest.fn();
const mockPacketFindFirst = jest.fn();
const mockAuthorizationFindMany = jest.fn();
const mockAuthorizationDeleteMany = jest.fn();
const mockRecordNodeChange = jest.fn();

const mockTx = {
  workspace_meeting_packets: {
    create: (...args) => mockPacketCreate(...args),
  },
  workspace_meeting_authorizations: {
    deleteMany: (...args) => mockAuthorizationDeleteMany(...args),
    create: jest.fn(),
  },
};

jest.mock("../../utils/prisma", () => ({
  $transaction: (...args) => mockTransaction(...args),
  workspace_meeting_packets: {
    findFirst: (...args) => mockPacketFindFirst(...args),
  },
  workspace_meeting_authorizations: {
    findMany: (...args) => mockAuthorizationFindMany(...args),
  },
}));

jest.mock("../../models/syncV2", () => ({
  SyncV2: {
    enabled: jest.fn().mockReturnValue(true),
    schemaReady: jest.fn().mockResolvedValue(true),
    recordNodeChange: (...args) => mockRecordNodeChange(...args),
  },
}));

jest.mock("../../models/workspaceThread", () => ({
  WorkspaceThread: {},
}));

jest.mock("../../models/workspaceCognition", () => ({
  contentHash: jest.fn(),
  WorkspaceCognition: {},
}));

const {
  WorkspaceMeetingDelegate,
} = require("../../models/workspaceMeetingDelegate");

describe("WorkspaceMeetingDelegate Sync V2 transaction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const packet = {
      id: 12,
      workspaceId: 4,
      packetKey: "packet-12",
      revision: 1,
      title: "Planning",
      status: "draft",
      selectionJson: "{}",
      sourceWhitelistJson: "{}",
      disclosureRulesJson: "{}",
      redactionRulesJson: "[]",
    };
    mockPacketCreate.mockResolvedValue(packet);
    mockPacketFindFirst.mockResolvedValue(packet);
    mockAuthorizationFindMany.mockResolvedValue([]);
    mockAuthorizationDeleteMany.mockResolvedValue({ count: 0 });
    mockRecordNodeChange.mockResolvedValue({ event: { seq: 31 } });
    mockTransaction.mockImplementation(async (callback) => callback(mockTx));
  });

  test("creates a packet and cursor event in one transaction", async () => {
    const packet = await WorkspaceMeetingDelegate.createPacket({
      workspaceId: 4,
      userId: 7,
      data: { title: "Planning" },
    });

    expect(packet.id).toBe(12);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockRecordNodeChange).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        nodeKey: "workspaces/4/meetings",
        eventType: "meeting.packet_created",
      })
    );
  });

  test("propagates an outbox failure so packet creation rolls back", async () => {
    mockRecordNodeChange.mockRejectedValueOnce(new Error("outbox_failed"));

    await expect(
      WorkspaceMeetingDelegate.createPacket({
        workspaceId: 4,
        data: { title: "Planning" },
      })
    ).rejects.toThrow("outbox_failed");
  });
});
