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
      ])
    );

    const { newValues, error } = await updateENV({
      ReaderOcrProvider: "alibaba",
      ReaderOcrApiKey: "sk-reader-ocr",
      ReaderOcrBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      ReaderOcrModelPref: "qwen-vl-ocr-latest",
    });

    expect(error).toBe(false);
    expect(newValues).toMatchObject({
      ReaderOcrProvider: "alibaba",
      ReaderOcrApiKey: "sk-reader-ocr",
      ReaderOcrBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      ReaderOcrModelPref: "qwen-vl-ocr-latest",
    });
    expect(process.env.READER_OCR_PROVIDER).toBe("alibaba");
    expect(process.env.READER_OCR_API_KEY).toBe("sk-reader-ocr");

    const backup = JSON.parse(
      fs.readFileSync(
        path.join(storageDir, "system", "provider-settings.backup.json"),
        "utf8"
      )
    );
    expect(backup.values).toMatchObject({
      READER_OCR_PROVIDER: "alibaba",
      READER_OCR_API_KEY: "sk-reader-ocr",
      READER_OCR_BASE_URL:
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
      READER_OCR_MODEL_PREF: "qwen-vl-ocr-latest",
    });
  });

  it("ignores masked reader OCR API keys and rejects invalid providers", async () => {
    const { updateENV } = loadUpdateENV();
    process.env.READER_OCR_API_KEY = "sk-existing";

    const masked = await updateENV({
      ReaderOcrApiKey: "********************",
    });
    expect(masked.error).toBe(false);
    expect(masked.newValues).toEqual({});
    expect(process.env.READER_OCR_API_KEY).toBe("sk-existing");

    const invalid = await updateENV({
      ReaderOcrProvider: "dashscope",
    });
    expect(invalid.error).toContain("Invalid reader OCR provider.");
    expect(process.env.READER_OCR_PROVIDER).toBe("alibaba");
  });
});
