const mockExecuteRawUnsafe = jest.fn();
const mockQueryRawUnsafe = jest.fn();

jest.mock("../../utils/prisma", () => ({
  $executeRawUnsafe: mockExecuteRawUnsafe,
  $queryRawUnsafe: mockQueryRawUnsafe,
}));

jest.mock("../../utils/files", () => ({
  cachedVectorInformation: jest.fn(),
  fileData: jest.fn(),
}));

describe("KnowledgeGraph node metric maintenance", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryRawUnsafe.mockResolvedValue([]);
    jest.resetModules();
  });

  it("clears stale warning state when marking selected node metrics stale", async () => {
    const { KnowledgeGraph } = require("../../models/knowledgeGraph");

    await KnowledgeGraph.markNodeMetricsStale({
      workspaceId: 6,
      nodeIds: [101],
      reason: "test",
    });

    const upsertSql = mockExecuteRawUnsafe.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes('INSERT INTO "KnowledgeNodeMetrics"'));
    expect(upsertSql).toContain('"warning"');
    expect(upsertSql).toContain('"warning" = NULL');
  });

  it("clears stale warning state when marking a workspace stale", async () => {
    mockQueryRawUnsafe.mockResolvedValue([{ count: 1 }]);
    const { KnowledgeGraph } = require("../../models/knowledgeGraph");

    await KnowledgeGraph.markWorkspaceNodeMetricsStale(6, "test");

    const updateSql = mockExecuteRawUnsafe.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes('UPDATE "KnowledgeNodeMetrics"'));
    expect(updateSql).toContain('"warning" = NULL');
  });

  it("interleaves global node metric candidates by workspace rank", async () => {
    const { KnowledgeGraph } = require("../../models/knowledgeGraph");

    await KnowledgeGraph.nodeMetricsCandidates({
      workspaceId: null,
      limit: 200,
    });

    const candidateSql = mockQueryRawUnsafe.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes("ranked_metrics"));
    expect(candidateSql).toContain("ROW_NUMBER() OVER");
    expect(candidateSql).toContain('PARTITION BY m."workspaceId"');
    expect(candidateSql).toContain('"workspaceRank" ASC');
  });
});
