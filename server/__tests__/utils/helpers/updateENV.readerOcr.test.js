/* eslint-env jest */
const fs = require("fs");
const os = require("os");
const path = require("path");

describe("Reader OCR updateENV settings", () => {
  const originalEnv = { ...process.env };
  let storageDir;
  let envPath;

  function loadUpdateENV() {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      NODE_ENV: "production",
      STORAGE_DIR: storageDir,
      DESKTOP_ENV_PATH: envPath,
    };
    return require("../../../utils/helpers/updateENV");
  }

  beforeEach(() => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "anythingllm-ocr-"));
    envPath = path.join(storageDir, ".env");
    fs.writeFileSync(envPath, "", "utf8");
  });

  afterEach(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  it("persists reader OCR provider settings into env and provider backup", async () => {
    const { PROVIDER_SETTING_KEYS, updateENV } = loadUpdateENV();
    expect(PROVIDER_SETTING_KEYS).toEqual(
      expect.arrayContaining([
        "ReaderOcrProvider",
        "ReaderOcrApiKey",
        "ReaderOcrBaseUrl",
        "ReaderOcrModelPref",
        "VisionProvider",
        "VisionApiKey",
        "VisionBaseUrl",
        "VisionModelPref",
        "VisionToolEnabled",
      ])
    );

    const { newValues, error } = await updateENV({
      ReaderOcrProvider: "alibaba",
      ReaderOcrApiKey: "sk-reader-ocr",
      ReaderOcrBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      ReaderOcrModelPref: "qwen-vl-ocr-latest",
      VisionProvider: "alibaba",
      VisionApiKey: "sk-vision",
      VisionBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      VisionModelPref: "qwen3-vl-flash",
      VisionToolEnabled: "true",
    });

    expect(error).toBe(false);
    expect(newValues).toMatchObject({
      ReaderOcrProvider: "alibaba",
      ReaderOcrApiKey: "sk-reader-ocr",
      ReaderOcrBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      ReaderOcrModelPref: "qwen-vl-ocr-latest",
      VisionProvider: "alibaba",
      VisionApiKey: "sk-vision",
      VisionBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      VisionModelPref: "qwen3-vl-flash",
      VisionToolEnabled: "true",
    });
    expect(process.env.READER_OCR_PROVIDER).toBe("alibaba");
    expect(process.env.READER_OCR_API_KEY).toBe("sk-reader-ocr");
    expect(process.env.VISION_PROVIDER).toBe("alibaba");
    expect(process.env.VISION_API_KEY).toBe("sk-vision");
    expect(process.env.VISION_TOOL_ENABLED).toBe("true");

    const backup = JSON.parse(
      fs.readFileSync(
        path.join(
          storageDir,
          "production",
          "system",
          "provider-settings.backup.json"
        ),
        "utf8"
      )
    );
    expect(backup.values).toMatchObject({
      READER_OCR_PROVIDER: "alibaba",
      READER_OCR_API_KEY: "sk-reader-ocr",
      READER_OCR_BASE_URL:
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
      READER_OCR_MODEL_PREF: "qwen-vl-ocr-latest",
      VISION_PROVIDER: "alibaba",
      VISION_API_KEY: "sk-vision",
      VISION_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      VISION_MODEL_PREF: "qwen3-vl-flash",
      VISION_TOOL_ENABLED: "true",
    });
  });

  it("ignores masked reader OCR and vision API keys and rejects invalid providers", async () => {
    const { updateENV } = loadUpdateENV();
    process.env.READER_OCR_PROVIDER = "alibaba";
    process.env.READER_OCR_API_KEY = "sk-existing";
    process.env.VISION_PROVIDER = "alibaba";
    process.env.VISION_API_KEY = "sk-vision-existing";

    const masked = await updateENV({
      ReaderOcrApiKey: "********************",
      VisionApiKey: "********************",
    });
    expect(masked.error).toBe(false);
    expect(masked.newValues).toEqual({});
    expect(process.env.READER_OCR_API_KEY).toBe("sk-existing");
    expect(process.env.VISION_API_KEY).toBe("sk-vision-existing");

    const invalid = await updateENV({
      ReaderOcrProvider: "dashscope",
    });
    expect(invalid.error).toContain("Invalid reader OCR provider.");
    expect(process.env.READER_OCR_PROVIDER).toBe("alibaba");

    const invalidVision = await updateENV({
      VisionProvider: "dashscope",
    });
    expect(invalidVision.error).toContain("Invalid vision provider.");
    expect(process.env.VISION_PROVIDER).toBe("alibaba");
  });
});
