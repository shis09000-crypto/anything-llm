const mockPrisma = {
  workspace_agent_invocations: {
    findFirst: jest.fn(),
    create: jest.fn(),
  },
};

jest.mock("../../utils/prisma", () => mockPrisma);

describe("WorkspaceAgentInvocation client turn idempotency", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("persists the originating client turn on a new invocation", async () => {
    mockPrisma.workspace_agent_invocations.findFirst.mockResolvedValue(null);
    mockPrisma.workspace_agent_invocations.create.mockImplementation(
      ({ data }) => Promise.resolve({ id: 9, ...data })
    );
    const {
      WorkspaceAgentInvocation,
    } = require("../../models/workspaceAgentInvocation");

    const result = await WorkspaceAgentInvocation.new({
      prompt: "run agent",
      workspace: { id: 4 },
      user: { id: 7 },
      thread: { id: 11 },
      clientTurnId: "turn-agent-1",
      requestedProvider: "deepseek",
      requestedModel: "deepseek-v4-flash",
    });

    expect(result.replayed).toBe(false);
    expect(mockPrisma.workspace_agent_invocations.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clientTurnId: "turn-agent-1",
        workspace_id: 4,
        user_id: 7,
        thread_id: 11,
        requestedProvider: "deepseek",
        requestedModel: "deepseek-v4-flash",
      }),
    });
  });

  it("reuses the same scoped invocation for a repeated client turn", async () => {
    const existing = {
      id: 9,
      uuid: "invocation-existing",
      clientTurnId: "turn-agent-1",
      workspace_id: 4,
      user_id: 7,
      thread_id: 11,
    };
    mockPrisma.workspace_agent_invocations.findFirst.mockResolvedValue(
      existing
    );
    const {
      WorkspaceAgentInvocation,
    } = require("../../models/workspaceAgentInvocation");

    const result = await WorkspaceAgentInvocation.new({
      prompt: "retry agent",
      workspace: { id: 4 },
      user: { id: 7 },
      thread: { id: 11 },
      clientTurnId: "turn-agent-1",
    });

    expect(result).toEqual({
      invocation: existing,
      message: null,
      replayed: true,
    });
    expect(
      mockPrisma.workspace_agent_invocations.create
    ).not.toHaveBeenCalled();
  });
});
