const {
  persistentHistoryAttachments,
  referencesRecentImage,
} = require("../../utils/imageAssets/historyPolicy");

describe("image asset history policy", () => {
  test("only selects persistent assets for active history reinjection", () => {
    const persistent = {
      kind: "persistent",
      assetId: "asset-1",
      name: "kept.png",
    };
    expect(
      persistentHistoryAttachments({
        attachments: [
          { contentString: "data:image/png;base64,bGVnYWN5" },
          {
            kind: "ephemeral",
            dataUrl: "data:image/jpeg;base64,dHVybg==",
          },
          persistent,
        ],
      })
    ).toEqual([persistent]);
  });

  test("recognizes explicit references to a recent image", () => {
    expect(referencesRecentImage("请继续分析刚才那张截图")).toBe(true);
    expect(referencesRecentImage("compare the previous image")).toBe(true);
    expect(referencesRecentImage("今天吃什么")).toBe(false);
  });
});
