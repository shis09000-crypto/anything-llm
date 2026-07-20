const mockPrisma = {
  workspace_meeting_authorizations: {
    findMany: jest.fn(),
  },
};

jest.mock("../../utils/prisma", () => mockPrisma);
jest.mock("../../models/workspaceThread", () => ({
  WorkspaceThread: {},
}));

describe("WorkspaceMeetingDelegate commitment policy", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function authorization(overrides = {}) {
    return {
      id: 41,
      workspaceId: 7,
      meetingPacketId: 12,
      actionType: "delivery_date",
      targetScopeJson: JSON.stringify({ allowedTargets: ["Project Athena"] }),
      limitsJson: JSON.stringify({
        maxAmount: 1000,
        maxQuantity: 5,
        maxDurationMinutes: 60,
        latestDueAt: "2030-01-31T00:00:00.000Z",
      }),
      conditionsJson: "{}",
      validFrom: new Date("2020-01-01T00:00:00.000Z"),
      validUntil: new Date("2030-12-31T00:00:00.000Z"),
      allowConditional: false,
      requiresSecondApproval: false,
      status: "active",
      ...overrides,
    };
  }

  it("allows a commitment inside the frozen authorization limits", async () => {
    mockPrisma.workspace_meeting_authorizations.findMany.mockResolvedValue([
      authorization(),
    ]);
    const {
      WorkspaceMeetingDelegate,
    } = require("../../models/workspaceMeetingDelegate");

    const result = await WorkspaceMeetingDelegate.validateCommitment({
      workspaceId: 7,
      packetId: 12,
      proposal: {
        actionType: "delivery_date",
        target: "Project Athena",
        amount: 800,
        quantity: 2,
        durationMinutes: 30,
        dueAt: "2030-01-15T00:00:00.000Z",
      },
    });

    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
    expect(result.authorization.id).toBe(41);
  });

  it("requires approval when amount, target, or deadline is out of bounds", async () => {
    mockPrisma.workspace_meeting_authorizations.findMany.mockResolvedValue([
      authorization(),
    ]);
    const {
      WorkspaceMeetingDelegate,
    } = require("../../models/workspaceMeetingDelegate");

    const result = await WorkspaceMeetingDelegate.validateCommitment({
      workspaceId: 7,
      packetId: 12,
      proposal: {
        actionType: "delivery_date",
        target: "Other Project",
        amount: 1200,
        dueAt: "2030-02-15T00:00:00.000Z",
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        allowed: false,
        requiresApproval: true,
        reason: "commitment_out_of_bounds",
      })
    );

    const omittedLimits = await WorkspaceMeetingDelegate.validateCommitment({
      workspaceId: 7,
      packetId: 12,
      proposal: {
        actionType: "delivery_date",
        target: "Project Athena",
      },
    });
    expect(omittedLimits.reason).toBe("commitment_out_of_bounds");
  });

  it("treats expired authorization as unavailable", async () => {
    mockPrisma.workspace_meeting_authorizations.findMany.mockResolvedValue([
      authorization({ validUntil: new Date("2021-01-01T00:00:00.000Z") }),
    ]);
    const {
      WorkspaceMeetingDelegate,
    } = require("../../models/workspaceMeetingDelegate");

    const result = await WorkspaceMeetingDelegate.validateCommitment({
      workspaceId: 7,
      packetId: 12,
      proposal: { actionType: "delivery_date" },
    });

    expect(result.reason).toBe("authorization_missing_or_expired");
    expect(result.requiresApproval).toBe(true);
  });
});
