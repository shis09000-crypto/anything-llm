const mockDataAccessCenter = {
  imageAsset: {
    pendingDeletion: jest.fn(),
    pendingMetadataEnrichment: jest.fn(),
    applyMetadataEnrichment: jest.fn(),
  },
};

jest.mock("../../utils/dataAccess", () => ({
  DataAccessCenter: mockDataAccessCenter,
}));
jest.mock("../../utils/imageAssets/adapter", () => ({
  deleteDeepSeekFile: jest.fn(),
  resolveImageInput: jest.fn(),
}));

const {
  runImageAssetMaintenance,
} = require("../../utils/imageAssets/service");

describe("image asset P2 maintenance", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDataAccessCenter.imageAsset.pendingDeletion.mockResolvedValue([]);
    mockDataAccessCenter.imageAsset.pendingMetadataEnrichment.mockResolvedValue([
      {
        id: "asset-1",
        mimeType: "image/png",
        displayName: "layout.png",
        width: 1600,
        height: 900,
        animated: false,
        sources: [{ sourceText: "请检查这个登录页面" }],
      },
    ]);
    mockDataAccessCenter.imageAsset.applyMetadataEnrichment.mockResolvedValue({
      id: "asset-1",
    });
  });

  test("enriches first-used assets without entering the request hot path", async () => {
    const result = await runImageAssetMaintenance({ limit: 10 });
    expect(result.priority).toBe("P2");
    expect(result.metadata).toEqual({ inspected: 1, completed: 1, failed: 0 });
    expect(
      mockDataAccessCenter.imageAsset.applyMetadataEnrichment
    ).toHaveBeenCalledWith("asset-1", {
      summary: "来源消息：请检查这个登录页面",
      tags: ["图片", "png", "横图"],
    });
  });
});
