const {
  deleteDeepSeekFile,
  uploadDeepSeekFile,
} = require("../imageAssets/adapter");
const { flashVisionModel } = require("../responsesRuntime/modelRouting");
const { providerResponsesClient } = require("./deepSeekResponses");

const PROBE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n1EAAAAASUVORK5CYII=",
  "base64"
);

async function probeFlashVision({
  providerFactory,
  env = process.env,
  uploadFile = uploadDeepSeekFile,
  deleteFile = deleteDeepSeekFile,
} = {}) {
  const requestedModel = "deepseek-v4-flash";
  const effectiveModel = flashVisionModel(env);
  let providerFileId = null;
  try {
    const uploaded = await uploadFile(
      {
        buffer: PROBE_PNG,
        name: "athena-flash-vision-probe.png",
        mimeType: "image/png",
      },
      { env }
    );
    providerFileId = uploaded.providerFileId;
    const provider = providerFactory({
      provider: "deepseek",
      model: effectiveModel,
    });
    const stream = await providerResponsesClient(provider)({
      model: effectiveModel,
      stream: true,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Reply with OK." },
            { type: "input_image", file_id: providerFileId },
          ],
        },
      ],
      max_output_tokens: 4,
    });
    if (!stream || typeof stream[Symbol.asyncIterator] !== "function")
      throw Object.assign(new Error("flash_vision_stream_unavailable"), {
        code: "flash_vision_stream_unavailable",
      });
    let completed = false;
    for await (const event of stream) {
      if (event?.type === "response.completed") completed = true;
      if (["response.failed", "response.incomplete"].includes(event?.type)) {
        const code =
          event?.response?.error?.code || "flash_vision_probe_failed";
        throw Object.assign(new Error(code), { code });
      }
    }
    if (!completed)
      throw Object.assign(new Error("flash_vision_terminal_missing"), {
        code: "flash_vision_terminal_missing",
      });
    return {
      ready: true,
      requestedModel,
      effectiveModel,
      responses: true,
      nativeImage: true,
      filesApi: true,
      checkedAt: new Date().toISOString(),
      error: null,
    };
  } catch (error) {
    return {
      ready: false,
      requestedModel,
      effectiveModel,
      responses: false,
      nativeImage: false,
      filesApi: false,
      checkedAt: new Date().toISOString(),
      error: String(
        error?.code || error?.message || "flash_vision_probe_failed"
      ).slice(0, 160),
    };
  } finally {
    if (providerFileId)
      await deleteFile(providerFileId, { env }).catch(() => null);
  }
}

module.exports = { probeFlashVision };
