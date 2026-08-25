const {
  probeFlashVision,
} = require("../../utils/modelGateway/flashVisionProbe");

async function* completedStream() {
  yield { type: "response.created" };
  yield { type: "response.output_text.delta", delta: "OK" };
  yield { type: "response.completed", response: { status: "completed" } };
}

describe("Flash Vision startup capability probe", () => {
  test("checks Files API, native image input, and a completed Responses stream", async () => {
    const create = jest.fn(async () => completedStream());
    const uploadFile = jest.fn(async () => ({ providerFileId: "file-probe" }));
    const deleteFile = jest.fn(async () => true);
    const result = await probeFlashVision({
      env: { DEEPSEEK_FLASH_VISION_MODEL: "vision-live" },
      providerFactory: () => ({ openai: { responses: { create } } }),
      uploadFile,
      deleteFile,
    });
    expect(result).toMatchObject({
      ready: true,
      effectiveModel: "vision-live",
      responses: true,
      nativeImage: true,
      filesApi: true,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "vision-live",
        stream: true,
        input: [
          expect.objectContaining({
            content: expect.arrayContaining([
              { type: "input_image", file_id: "file-probe" },
            ]),
          }),
        ],
      })
    );
    expect(deleteFile).toHaveBeenCalledWith(
      "file-probe",
      expect.objectContaining({ env: expect.any(Object) })
    );
  });

  test("fails closed when no completed terminal is observed", async () => {
    async function* unfinished() {
      yield { type: "response.created" };
    }
    const result = await probeFlashVision({
      env: {},
      providerFactory: () => ({
        openai: { responses: { create: async () => unfinished() } },
      }),
      uploadFile: async () => ({ providerFileId: "file-probe" }),
      deleteFile: async () => true,
    });
    expect(result.ready).toBe(false);
    expect(result.error).toBe("flash_vision_terminal_missing");
  });
});
