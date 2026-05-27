const mockQueryRawUnsafe = jest.fn();

jest.mock("../../../utils/prisma", () => ({
  $queryRawUnsafe: mockQueryRawUnsafe,
}));

jest.mock("../../../models/knowledgeGraph", () => ({
  KnowledgeGraph: {
    canonicalKey: (value = "") =>
      String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[_\s]+/g, "-")
        .replace(/[^a-z0-9\u4e00-\u9fff-]+/g, "")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, ""),
  },
}));

const { resolveNodeIdentity } = require("../../../utils/knowledgeGraph/nodeIdentityResolver");

const nodes = [
  {
    id: 101,
    workspaceId: 7,
    canonicalName: "Thales",
    canonicalKey: "thales",
    aliases: JSON.stringify(["米利都的泰勒斯"]),
    entityType: "person",
    displayNameZh: "泰勒斯",
    displayNameEn: "Thales",
  },
  {
    id: 202,
    workspaceId: 7,
    canonicalName: "Arche",
    canonicalKey: "arche",
    aliases: "[]",
    entityType: "concept",
    displayNameZh: "本原",
    displayNameEn: "Arche",
  },
];

function setupNodeQueryMock(extraNodes = []) {
  const rows = [...nodes, ...extraNodes];
  mockQueryRawUnsafe.mockImplementation((sql, ...params) => {
    if (sql.includes('WHERE "workspaceId" = ? AND "id" = ?')) {
      return Promise.resolve(
        rows.filter(
          (row) =>
            Number(row.workspaceId) === Number(params[0]) &&
            Number(row.id) === Number(params[1])
        )
      );
    }
    if (sql.includes('WHERE "workspaceId" = ? AND "canonicalKey" = ?')) {
      return Promise.resolve(
        rows.filter(
          (row) =>
            Number(row.workspaceId) === Number(params[0]) &&
            row.canonicalKey === params[1]
        )
      );
    }
    if (
      sql.includes('FROM "KnowledgeNode"') &&
      sql.includes('WHERE "workspaceId" = ?')
    ) {
      return Promise.resolve(
        rows.filter((row) => Number(row.workspaceId) === Number(params[0]))
      );
    }
    return Promise.resolve([]);
  });
}

describe("resolveNodeIdentity", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupNodeQueryMock();
  });

  it("resolves legacy node keys to stable kg node identity", async () => {
    const result = await resolveNodeIdentity({
      workspaceId: 7,
      nodeKey: "person:thales",
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        node: expect.objectContaining({
          nodeId: 101,
          nodeKey: "kg:person:thales",
          identitySource: "nodeKey",
        }),
      })
    );
  });

  it("resolves canonical keys without relying on labels", async () => {
    const result = await resolveNodeIdentity({
      workspaceId: 7,
      canonicalKey: "arche",
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        node: expect.objectContaining({
          nodeId: 202,
          nodeKey: "kg:concept:arche",
          identitySource: "canonicalKey",
        }),
      })
    );
  });

  it("returns candidates instead of guessing when labels are ambiguous", async () => {
    setupNodeQueryMock([
      {
        id: 303,
        workspaceId: 7,
        canonicalName: "Thales Concept",
        canonicalKey: "thales-concept",
        aliases: "[]",
        entityType: "concept",
        displayNameZh: "泰勒斯",
        displayNameEn: "Thales Concept",
      },
    ]);

    const result = await resolveNodeIdentity({
      workspaceId: 7,
      label: "泰勒斯",
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe("ambiguous_node_identity");
    expect(result.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeKey: "kg:person:thales" }),
        expect.objectContaining({ nodeKey: "kg:concept:thales-concept" }),
      ])
    );
  });
});
