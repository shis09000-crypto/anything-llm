const mockPrisma = {
  workspace_thread_plans: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  $transaction: jest.fn(),
};

jest.mock("../../utils/prisma", () => mockPrisma);

const { WorkspaceThreadPlan } = require("../../models/workspaceThreadPlan");

const workspace = { id: 10 };
const thread = { id: 20 };
const user = { id: 30 };

describe("WorkspaceThreadPlan", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation((operation) =>
      operation(mockPrisma)
    );
  });

  test("creates one durable draft for a plan turn", async () => {
    mockPrisma.workspace_thread_plans.findUnique.mockResolvedValue(null);
    mockPrisma.workspace_thread_plans.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 1, ...data })
    );

    const result = await WorkspaceThreadPlan.resolveForTurn({
      workspace,
      thread,
      user,
      clientTurnId: "turn-1",
      objective: "Improve the composer",
      plan: { action: "create" },
    });

    expect(result.created).toBe(true);
    expect(result.plan).toMatchObject({
      objective: "Improve the composer",
      createClientTurnId: "turn-1",
      activeScopeKey: "10:20",
      status: "drafting",
    });
  });

  test("parses a Markdown checklist into executable steps", () => {
    expect(
      WorkspaceThreadPlan.planFromMarkdown(
        "# Composer plan\n\n- [ ] Inspect the current state\n- [x] Keep Responses terminal semantics"
      )
    ).toEqual({
      title: "Composer plan",
      steps: [
        { id: "step-1", step: "Inspect the current state", status: "pending" },
        {
          id: "step-2",
          step: "Keep Responses terminal semantics",
          status: "completed",
        },
      ],
    });
  });

  test("rejects multiple in-progress steps", async () => {
    await expect(
      WorkspaceThreadPlan.updateSteps({
        planId: "plan-1",
        clientTurnId: "turn-2",
        steps: [
          { id: "a", step: "One", status: "in_progress" },
          { id: "b", step: "Two", status: "in_progress" },
        ],
      })
    ).rejects.toMatchObject({ code: "plan_multiple_in_progress" });
  });
});
