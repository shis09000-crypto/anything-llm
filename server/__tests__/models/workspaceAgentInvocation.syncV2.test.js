const mockFindFirst = jest.fn();
const mockCreate = jest.fn();
const mockTxFindUnique = jest.fn();
const mockUpdate = jest.fn();
const mockTransaction = jest.fn();
const mockRecordNodeChange = jest.fn();

const mockTx = {
  workspace_agent_invocations: {
    create: (...args) => mockCreate(...args),
    findUnique: (...args) => mockTxFindUnique(...args),
    update: (...args) => mockUpdate(...args),
  },
};

jest.mock("../../utils/prisma", () => ({
  workspace_agent_invocations: {
    findFirst: (...args) => mockFindFirst(...args),
  },
  $transaction: (...args) => mockTransaction(...args),
}));

jest.mock("../../models/syncV2", () => ({
  SyncV2: {
    enabled: jest.fn().mockReturnValue(true),
    schemaReady: jest.fn().mockResolvedValue(true),
    recordNodeChange: (...args) => mockRecordNodeChange(...args),
  },
}));

const {
  WorkspaceAgentInvocation,
} = require("../../models/workspaceAgentInvocation");

describe("WorkspaceAgentInvocation Sync V2 transaction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindFirst.mockResolvedValue(null);
    mockCreate.mockResolvedValue({
      id: 8,
      uuid: "agent-8",
      workspace_id: 4,
      thread_id: 11,
      closed: false,
    });
    mockTxFindUnique.mockResolvedValue(null);
    mockUpdate.mockResolvedValue({
      id: 8,
      uuid: "agent-8",
      workspace_id: 4,
      thread_id: 11,
      closed: true,
    });
    mockRecordNodeChange.mockResolvedValue({ event: { seq: 30 } });
    mockTransaction.mockImplementation(async (callback) => callback(mockTx));
  });

  test("creates the invocation and cursor event in one transaction", async () => {
    const result = await WorkspaceAgentInvocation.new({
      prompt: "run agent",
      workspace: { id: 4 },
      thread: { id: 11 },
    });

    expect(result.invocation.id).toBe(8);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockRecordNodeChange).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        nodeKey: "workspaces/4/agents",
        eventType: "agent.invocation_created",
      })
    );
    expect(JSON.stringify(mockRecordNodeChange.mock.calls[0])).not.toContain(
      "run agent"
    );
  });

  test("propagates an outbox failure to the enclosing transaction", async () => {
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
    mockRecordNodeChange.mockRejectedValueOnce(new Error("outbox_failed"));
    const result = await WorkspaceAgentInvocation.new({
      prompt: "run agent",
      workspace: { id: 4 },
    });

    expect(result.invocation).toBeNull();
    expect(result.message).toBe("outbox_failed");
    errorLog.mockRestore();
  });

  test("does not emit another cursor event for an already closed invocation", async () => {
    mockTxFindUnique.mockResolvedValueOnce({
      id: 8,
      uuid: "agent-8",
      workspace_id: 4,
      closed: true,
    });

    await expect(WorkspaceAgentInvocation.close("agent-8")).resolves.toBe(true);

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockRecordNodeChange).not.toHaveBeenCalled();
  });
});
