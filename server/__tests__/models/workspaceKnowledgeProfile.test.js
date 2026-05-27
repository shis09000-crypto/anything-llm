const mockExecuteRawUnsafe = jest.fn();
const mockQueryRawUnsafe = jest.fn();

jest.mock("../../utils/prisma", () => ({
  $executeRawUnsafe: mockExecuteRawUnsafe,
  $queryRawUnsafe: mockQueryRawUnsafe,
}));

describe("WorkspaceKnowledgeProfile model", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("casts datetime fields to text when reading profile cache rows", async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([
      {
        id: 1,
        workspaceId: 6,
        profileType: "book",
        confidence: 0.8,
        primaryDocumentIdsJson: "[]",
        detectedStructureJson: "{}",
        profileVersion: "workspace-profile-v1",
        manualOverride: 0,
        metadataJson: "{}",
        lastAnalyzedAt: "2026-05-26 19:02:32.275",
        nextRefreshAfter: "2026-05-27 19:02:32.275",
      },
    ]);
    const { WorkspaceKnowledgeProfile } = require("../../models/workspaceKnowledgeProfile");

    const profile = await WorkspaceKnowledgeProfile.get(6);

    expect(profile.profileType).toBe("book");
    expect(mockQueryRawUnsafe.mock.calls[0][0]).toContain(
      'CAST("lastAnalyzedAt" AS TEXT)'
    );
    expect(mockQueryRawUnsafe.mock.calls[0][0]).not.toMatch(/SELECT \*/);
  });
});
