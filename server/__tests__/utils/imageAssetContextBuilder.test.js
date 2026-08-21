const mockList = jest.fn();

jest.mock("../../utils/dataAccess", () => ({
  DataAccessCenter: {
    imageAsset: { list: mockList },
  },
}));

const {
  appendMultimodalTail,
  buildMultimodalContext,
} = require("../../utils/imageAssets/contextBuilder");

const ASSET_ID = "11111111-1111-4111-8111-111111111111";

describe("MultimodalContextBuilder", () => {
  beforeEach(() => {
    mockList.mockReset();
    mockList.mockResolvedValue({
      items: [
        {
          id: ASSET_ID,
          displayName: "历史设计稿.png",
          mimeType: "image/png",
          byteSize: 1024,
          pinned: true,
          summary: "登录页设计稿",
          createdAt: new Date("2026-08-01T00:00:00.000Z"),
          lastUsedAt: new Date("2026-08-02T00:00:00.000Z"),
        },
      ],
    });
  });

  test("restores a compacted historical asset only in the dynamic tail", async () => {
    const context = await buildMultimodalContext({
      workspaceId: 7,
      userId: 3,
      threadId: 9,
      prompt: `继续分析图片 ${ASSET_ID}`,
      currentAttachments: [],
    });
    const stableHistory = [
      { role: "system", content: "stable" },
      { role: "user", content: "压缩后的当前问题" },
    ];
    const projected = appendMultimodalTail(stableHistory, context);

    expect(projected[0]).toEqual(stableHistory[0]);
    expect(stableHistory[1]).toEqual({
      role: "user",
      content: "压缩后的当前问题",
    });
    expect(projected[1].attachments).toEqual([
      expect.objectContaining({ kind: "persistent", assetId: ASSET_ID }),
    ]);
    expect(projected[1].content).toContain("<available_image_assets>");
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 9, limit: 32 })
    );
  });

  test("does not automatically reattach history when current images exist", async () => {
    const context = await buildMultimodalContext({
      workspaceId: 7,
      userId: 3,
      threadId: 9,
      prompt: "比较这些图片",
      currentAttachments: [{ imageAssetId: "current-asset" }],
    });
    expect(context.recoveredAttachments).toEqual([]);
  });
});
