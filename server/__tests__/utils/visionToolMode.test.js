const { shouldUseVisionTool } = require("../../utils/vision/viewTool");

describe("legacy vision tool mode", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  test("is paused by default even when the old tool remains configured", () => {
    delete process.env.ATHENA_CHAT_IMAGE_MODE;
    process.env.VISION_TOOL_ENABLED = "true";
    process.env.VISION_PROVIDER = "alibaba";
    expect(
      shouldUseVisionTool([
        { mime: "image/png", contentString: "data:image/png;base64,eA==" },
      ])
    ).toBe(false);
  });

  test("can only be restored through the explicit legacy rollback mode", () => {
    process.env.ATHENA_CHAT_IMAGE_MODE = "legacy";
    process.env.VISION_TOOL_ENABLED = "true";
    process.env.VISION_PROVIDER = "alibaba";
    expect(
      shouldUseVisionTool([
        { mime: "image/png", contentString: "data:image/png;base64,eA==" },
      ])
    ).toBe(true);
  });
});
