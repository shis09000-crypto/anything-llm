const {
  VISION_MODEL,
  capEphemeralToolFrames,
  clearProviderFileCache,
  prepareResponsesInput,
  uploadDeepSeekImage,
} = require("../../utils/responsesRuntime/multimodalInput");
const sharp = require("sharp");

function image(name) {
  return {
    kind: "persistent",
    assetId: `asset-${name}`,
    name,
    mime: "image/png",
    byteSize: 123,
    sha256: `sha-${name}`,
    detail: "original",
  };
}

function persistentResolver(ref) {
  return Promise.resolve({
    type: "input_image",
    file_id: `file-api-${ref.assetId.replace("asset-", "")}`,
    bindingId: `binding-${ref.assetId}`,
    assetId: ref.assetId,
  });
}

describe("Responses Runtime native multimodal input", () => {
  beforeEach(() => clearProviderFileCache());

  test("keeps pure Pro text compatible", async () => {
    await expect(
      prepareResponsesInput([{ role: "user", content: "hello" }], {
        model: "deepseek-v4-pro",
      })
    ).resolves.toEqual({
      input: [{ type: "message", role: "user", content: "hello" }],
      model: "deepseek-v4-pro",
      sawImage: false,
    });
  });

  test("upgrades the Flash main route to the native vision model", async () => {
    const prepared = await prepareResponsesInput(
      [{ role: "user", content: "hello" }],
      { model: "deepseek-v4-flash" }
    );
    expect(prepared.model).toBe(VISION_MODEL);
    expect(prepared.sawImage).toBe(false);
  });

  test("serializes one image and text as input_image file_id", async () => {
    const resolveImage = jest.fn(persistentResolver);
    const prepared = await prepareResponsesInput(
      [{ role: "user", content: "what is this", attachments: [image("one")] }],
      { model: "deepseek-v4-pro", workspaceId: 1, resolveImage }
    );
    expect(prepared.model).toBe(VISION_MODEL);
    expect(prepared.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "what is this" },
          {
            type: "input_image",
            file_id: "file-api-one",
            athena_asset_id: "asset-one",
          },
        ],
      },
    ]);
    expect(JSON.stringify(prepared.input)).not.toContain("image_url");
    expect(resolveImage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "persistent", assetId: "asset-one" }),
      expect.objectContaining({ workspaceId: 1 })
    );
  });

  test("supports multiple images in one mixed message", async () => {
    const prepared = await prepareResponsesInput(
      [
        {
          role: "user",
          content: "compare",
          attachments: [image("first"), image("second")],
        },
      ],
      {
        model: "deepseek-v4-flash",
        workspaceId: 1,
        resolveImage: persistentResolver,
      }
    );
    expect(prepared.input[0].content).toEqual([
      { type: "input_text", text: "compare" },
      {
        type: "input_image",
        file_id: "file-api-first",
        athena_asset_id: "asset-first",
      },
      {
        type: "input_image",
        file_id: "file-api-second",
        athena_asset_id: "asset-second",
      },
    ]);
  });

  test("retains images in multi-turn conversation context", async () => {
    const prepared = await prepareResponsesInput(
      [
        { role: "user", content: "remember", attachments: [image("history")] },
        { role: "assistant", content: "I can see it." },
        { role: "user", content: "what color was it?" },
      ],
      {
        model: "deepseek-v4-pro",
        workspaceId: 1,
        resolveImage: persistentResolver,
      }
    );
    expect(prepared.model).toBe(VISION_MODEL);
    expect(prepared.input[0].content[1]).toEqual({
      type: "input_image",
      file_id: "file-api-history",
      athena_asset_id: "asset-history",
    });
    expect(prepared.input[2]).toEqual({
      type: "message",
      role: "user",
      content: "what color was it?",
    });
  });

  test("keeps tool screenshots turn-scoped as Base64 function output", async () => {
    const dataUrl = `data:image/png;base64,${Buffer.from("frame").toString("base64")}`;
    const prepared = await prepareResponsesInput(
      [
        {
          role: "function",
          name: "browser_capture",
          content: '{"sha256":"frame"}',
          originalFunctionCall: { id: "call_1", name: "browser_capture" },
          attachments: [
            {
              kind: "ephemeral",
              source: "browser_capture",
              dataUrl,
              mime: "image/png",
            },
          ],
        },
      ],
      { model: "deepseek-v4-pro" }
    );
    expect(prepared.input[1]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: [
        { type: "input_text", text: '{"sha256":"frame"}' },
        { type: "input_image", image_url: dataUrl, detail: "original" },
      ],
    });
  });

  test("keeps only the current and previous ephemeral tool frames", () => {
    const messages = [1, 2, 3].map((frame) => ({
      role: "tool",
      attachments: [
        {
          kind: "ephemeral",
          dataUrl: `data:image/jpeg;base64,${Buffer.from(String(frame)).toString("base64")}`,
        },
      ],
    }));
    const capped = capEphemeralToolFrames(messages, 2);
    expect(capped[0].attachments).toBeUndefined();
    expect(capped[1].attachments).toHaveLength(1);
    expect(capped[2].attachments).toHaveLength(1);
  });

  test("uploads original supported image bytes through the DeepSeek Files API", async () => {
    const png = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: { r: 12, g: 34, b: 56, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const fetchImpl = jest.fn(async (_url, options) => ({
      ok: true,
      status: 200,
      json: async () => ({ id: "file-api-uploaded" }),
      options,
    }));
    await expect(
      uploadDeepSeekImage(
        {
          name: "original.png",
          dataUrl: `data:image/png;base64,${png.toString("base64")}`,
        },
        { env: { DEEPSEEK_API_KEY: "test-key" }, fetchImpl }
      )
    ).resolves.toBe("file-api-uploaded");
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/files");
    expect(request.headers.Authorization).toBe("Bearer test-key");
    expect(request.body.get("purpose")).toBe("user_data");
    expect(request.body.get("expires_after[anchor]")).toBe("created_at");
    expect(request.body.get("file").type).toBe("image/png");
    expect(request.body.get("file").size).toBe(png.length);
  });
});
