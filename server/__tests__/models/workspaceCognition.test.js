const mockPrisma = {
  workspace_cognitive_assertions: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    count: jest.fn(),
  },
  workspace_cognitive_positions: {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  workspace_cognitive_evidence: {
    findMany: jest.fn(),
    updateMany: jest.fn(),
    upsert: jest.fn(),
  },
  workspace_cognitive_relations: { deleteMany: jest.fn() },
  workspace_cognitive_profiles: { deleteMany: jest.fn() },
  workspace_cognitive_extraction_jobs: { deleteMany: jest.fn() },
  workspace_meeting_packets: { deleteMany: jest.fn() },
  workspace_meeting_authorizations: { deleteMany: jest.fn() },
  workspace_meeting_sessions: { deleteMany: jest.fn() },
  workspace_meeting_audit_events: { deleteMany: jest.fn() },
};

jest.mock("../../utils/prisma", () => mockPrisma);

describe("WorkspaceCognition", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("deduplicates assertions only inside the same workspace", async () => {
    mockPrisma.workspace_cognitive_assertions.findUnique.mockResolvedValue(
      null
    );
    mockPrisma.workspace_cognitive_assertions.create.mockImplementation(
      async ({ data }) => ({ id: 17, ...data })
    );
    const { WorkspaceCognition } = require("../../models/workspaceCognition");

    const result = await WorkspaceCognition.createAssertion({
      workspaceId: 8,
      assertionType: "conclusion",
      statement: "  我认为   应先验证证据。 ",
      createdByType: "user",
      createdByUserId: 3,
    });

    expect(result.created).toBe(true);
    expect(result.assertion.statement).toBe("我认为 应先验证证据。");
    expect(
      mockPrisma.workspace_cognitive_assertions.findUnique
    ).toHaveBeenCalledWith({
      where: {
        workspaceId_normalizedHash: {
          workspaceId: 8,
          normalizedHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
  });

  it("rejects evidence from a different workspace before persistence", async () => {
    const { WorkspaceCognition } = require("../../models/workspaceCognition");

    await expect(
      WorkspaceCognition.addEvidence({
        workspaceId: 1,
        sourceWorkspaceId: 2,
        assertionId: 9,
        evidenceKind: "supports",
        sourceType: "document_chunk",
        sourceRef: "document:a:chunk:b",
      })
    ).rejects.toThrow("cross_workspace_evidence_forbidden");
    expect(
      mockPrisma.workspace_cognitive_evidence.upsert
    ).not.toHaveBeenCalled();
  });

  it("promotes the proposition only after its owner confirms a position", async () => {
    mockPrisma.workspace_cognitive_positions.findFirst.mockResolvedValue({
      id: 12,
      workspaceId: 4,
      assertionId: 22,
      subjectUserId: 5,
      status: "candidate",
      conditionsJson: "{}",
    });
    mockPrisma.workspace_cognitive_positions.update.mockResolvedValue({
      id: 12,
      workspaceId: 4,
      assertionId: 22,
      subjectUserId: 5,
      status: "confirmed",
      conditionsJson: "{}",
    });
    mockPrisma.workspace_cognitive_assertions.updateMany.mockResolvedValue({
      count: 1,
    });
    const { WorkspaceCognition } = require("../../models/workspaceCognition");

    const position = await WorkspaceCognition.patchPosition(4, 12, {
      status: "confirmed",
    });

    expect(position.status).toBe("confirmed");
    expect(
      mockPrisma.workspace_cognitive_assertions.updateMany
    ).toHaveBeenCalledWith({
      where: {
        id: 22,
        workspaceId: 4,
        verificationStatus: "candidate",
      },
      data: { verificationStatus: "user_confirmed", reviewReason: null },
    });
  });

  it("marks document evidence stale and downgrades dependent assertions", async () => {
    mockPrisma.workspace_cognitive_evidence.findMany.mockResolvedValue([
      { assertionId: 11 },
      { assertionId: 12 },
    ]);
    mockPrisma.workspace_cognitive_evidence.updateMany.mockResolvedValue({
      count: 2,
    });
    mockPrisma.workspace_cognitive_assertions.updateMany.mockResolvedValue({
      count: 2,
    });
    const { WorkspaceCognition } = require("../../models/workspaceCognition");

    const result = await WorkspaceCognition.markDocumentEvidenceStale(
      7,
      ["doc-1"],
      "source_deleted"
    );

    expect(result).toEqual({ evidence: 2, assertions: 2 });
    expect(
      mockPrisma.workspace_cognitive_assertions.updateMany
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: 7,
          id: { in: [11, 12] },
        }),
        data: {
          verificationStatus: "candidate",
          reviewReason: "source_deleted",
        },
      })
    );
  });

  it("removes every cognition and meeting row when a workspace is deleted", async () => {
    const tables = [
      "workspace_meeting_audit_events",
      "workspace_meeting_sessions",
      "workspace_meeting_authorizations",
      "workspace_meeting_packets",
      "workspace_cognitive_extraction_jobs",
      "workspace_cognitive_evidence",
      "workspace_cognitive_positions",
      "workspace_cognitive_relations",
      "workspace_cognitive_profiles",
      "workspace_cognitive_assertions",
    ];
    for (const table of tables) {
      mockPrisma[table].deleteMany = jest.fn().mockResolvedValue({ count: 1 });
    }
    const { WorkspaceCognition } = require("../../models/workspaceCognition");

    await WorkspaceCognition.deleteWorkspaceData([9]);

    for (const table of tables) {
      expect(mockPrisma[table].deleteMany).toHaveBeenCalledWith({
        where: { workspaceId: { in: [9] } },
      });
    }
  });
});
