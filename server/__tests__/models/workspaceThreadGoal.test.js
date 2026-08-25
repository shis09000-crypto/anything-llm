const mockPrisma = {
  workspace_thread_goals: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  $transaction: jest.fn(),
};

jest.mock("../../utils/prisma", () => mockPrisma);

const { WorkspaceThreadGoal } = require("../../models/workspaceThreadGoal");

const workspace = { id: 10 };
const thread = { id: 20 };
const user = { id: 30 };

describe("WorkspaceThreadGoal", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation((operation) =>
      operation(mockPrisma)
    );
  });

  test("creates one durable goal for a client turn", async () => {
    mockPrisma.workspace_thread_goals.findUnique.mockResolvedValue(null);
    mockPrisma.workspace_thread_goals.findFirst.mockResolvedValue(null);
    mockPrisma.workspace_thread_goals.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 1, ...data })
    );

    const result = await WorkspaceThreadGoal.resolveForTurn({
      workspace,
      thread,
      user,
      clientTurnId: "turn-1",
      objective: "Ship the feature",
      goal: { action: "create" },
    });

    expect(result.created).toBe(true);
    expect(result.goal).toMatchObject({
      objective: "Ship the feature",
      sourceClientTurnId: "turn-1",
      activeScopeKey: "10:20",
    });
  });

  test("reuses the system goal id when a client turn is retried", async () => {
    const existing = {
      id: 1,
      uuid: "goal-1",
      workspace_id: 10,
      thread_id: 20,
      user_id: 30,
    };
    mockPrisma.workspace_thread_goals.findUnique.mockResolvedValue(existing);

    await expect(
      WorkspaceThreadGoal.resolveForTurn({
        workspace,
        thread,
        user,
        clientTurnId: "turn-1",
        objective: "Ship the feature",
        goal: { action: "create" },
      })
    ).resolves.toMatchObject({
      goal: existing,
      created: false,
      replayed: true,
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  test("rejects a stale concurrent goal replacement", async () => {
    mockPrisma.workspace_thread_goals.findUnique.mockResolvedValue(null);
    mockPrisma.workspace_thread_goals.findFirst.mockResolvedValue({
      id: 1,
      uuid: "newer-goal",
      status: "active",
    });

    await expect(
      WorkspaceThreadGoal.resolveForTurn({
        workspace,
        thread,
        user,
        clientTurnId: "turn-2",
        objective: "Replace it",
        goal: {
          action: "replace",
          expectedActiveGoalId: "older-goal",
        },
      })
    ).rejects.toMatchObject({ code: "goal_active_changed", httpStatus: 409 });
    expect(mockPrisma.workspace_thread_goals.update).not.toHaveBeenCalled();
  });

  test.each(["completed", "blocked"])(
    "commits a staged %s status only for the successful turn",
    async (status) => {
      mockPrisma.workspace_thread_goals.findFirst.mockResolvedValue({
        id: 1,
        uuid: "goal-1",
        status: "active",
        pendingStatus: status,
        pendingStatusClientTurnId: "turn-1",
      });
      mockPrisma.workspace_thread_goals.updateMany.mockResolvedValue({
        count: 1,
      });

      await expect(
        WorkspaceThreadGoal.commitStatus({
          goalId: "goal-1",
          clientTurnId: "turn-1",
        })
      ).resolves.toMatchObject({ status });

      expect(mockPrisma.workspace_thread_goals.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: "active",
            pendingStatus: status,
            pendingStatusClientTurnId: "turn-1",
          }),
          data: expect.objectContaining({
            status,
            statusClientTurnId: "turn-1",
            activeScopeKey: null,
          }),
        })
      );
    }
  );

  test("rejects an unsupported staged status", async () => {
    await expect(
      WorkspaceThreadGoal.stageStatus({
        goalId: "goal-1",
        clientTurnId: "turn-1",
        status: "abandoned",
      })
    ).rejects.toMatchObject({ code: "goal_status_invalid" });
  });
});
