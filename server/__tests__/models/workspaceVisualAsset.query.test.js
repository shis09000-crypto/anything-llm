const mockPrisma = {
  $executeRawUnsafe: jest.fn(),
  $queryRawUnsafe: jest.fn(),
};

jest.mock("../../utils/prisma", () => mockPrisma);
jest.mock("../../utils/database/schemaIntrospection", () => ({
  ensureMigrationOwnedTables: jest.fn(async () => true),
}));

const { WorkspaceVisualAsset } = require("../../models/workspaceVisualAsset");

const row = {
  id: 6,
  workspaceId: 1,
  scopeType: "workspace",
  nodeKey: null,
  nodeLabel: null,
  nodeType: null,
  role: "hero_background",
  filename: "overview.webp",
  mime: "image/webp",
  size: 42,
  metadataJson: JSON.stringify({
    imageWidth: 1600,
    imageHeight: 900,
    dominantColor: "#ddeeff",
    averageColor: "#e8eef7",
    brightness: 0.8,
    contrastHint: "light",
    temperatureHint: "cool",
  }),
  deletedAt: null,
  createdAt: "2026-06-01 09:04:33",
  updatedAt: "2026-06-01 09:04:33",
};

function latestQuery() {
  return mockPrisma.$queryRawUnsafe.mock.calls.at(-1)?.[0] || "";
}

function expectPortableVisualAssetProjection(query) {
  expect(query).toContain('FROM "WorkspaceVisualAsset" AS visual_asset');
  expect(query).not.toMatch(/SELECT\s+\*/i);
  expect(query).toContain('visual_asset."createdAt"');
  expect(query).toContain('visual_asset."updatedAt"');
}

describe("WorkspaceVisualAsset PostgreSQL-safe reads", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$queryRawUnsafe.mockResolvedValue([row]);
  });

  test("qualifies the current asset ordering and preserves its URL", async () => {
    const asset = await WorkspaceVisualAsset.forWorkspace({
      workspaceId: 1,
      workspaceSlug: "workspace-one",
    });

    const query = latestQuery();
    expectPortableVisualAssetProjection(query);
    expect(query).toContain('ORDER BY visual_asset."updatedAt" DESC');
    expect(query).toContain('visual_asset."id" DESC');
    expect(asset).toMatchObject({
      id: 6,
      url: expect.stringContaining(
        "/api/workspace/workspace-one/visual-assets/6/file"
      ),
    });
  });

  test("uses the same qualified projection for list and get", async () => {
    await WorkspaceVisualAsset.list({ workspaceId: 1 });
    expectPortableVisualAssetProjection(latestQuery());
    expect(latestQuery()).toContain('ORDER BY visual_asset."updatedAt" DESC');

    await WorkspaceVisualAsset.get({ workspaceId: 1, id: 6 });
    expectPortableVisualAssetProjection(latestQuery());
  });
});
