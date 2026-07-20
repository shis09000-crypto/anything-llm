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
        "SearchModelProvider",
        "SearchModelApiKey",
        "SearchModelBaseUrl",
        "SearchModelPref",
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
      ReaderOcrModelPref: "qwen3.5-ocr",
      SearchModelProvider: "alibaba",
      SearchModelApiKey: "sk-search-model",
      SearchModelBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      SearchModelPref: "qwen3.7-plus",
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
      ReaderOcrModelPref: "qwen3.5-ocr",
      SearchModelProvider: "alibaba",
      SearchModelApiKey: "sk-search-model",
      SearchModelBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      SearchModelPref: "qwen3.7-plus",
      VisionProvider: "alibaba",
      VisionApiKey: "sk-vision",
      VisionBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      VisionModelPref: "qwen3-vl-flash",
      VisionToolEnabled: "true",
    });
    expect(process.env.READER_OCR_PROVIDER).toBe("alibaba");
    expect(process.env.READER_OCR_API_KEY).toBe("sk-reader-ocr");
    expect(process.env.SEARCH_MODEL_PROVIDER).toBe("alibaba");
    expect(process.env.SEARCH_MODEL_API_KEY).toBe("sk-search-model");
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
      READER_OCR_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      READER_OCR_MODEL_PREF: "qwen3.5-ocr",
      SEARCH_MODEL_PROVIDER: "alibaba",
      SEARCH_MODEL_API_KEY: "sk-search-model",
      SEARCH_MODEL_BASE_URL:
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
      SEARCH_MODEL_PREF: "qwen3.7-plus",
      VISION_PROVIDER: "alibaba",
      VISION_API_KEY: "sk-vision",
      VISION_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      VISION_MODEL_PREF: "qwen3-vl-flash",
      VISION_TOOL_ENABLED: "true",
    });
  });

  it("ignores masked reader OCR, search model, and vision API keys and rejects invalid providers", async () => {
    const { updateENV } = loadUpdateENV();
    process.env.READER_OCR_PROVIDER = "alibaba";
    process.env.READER_OCR_API_KEY = "sk-existing";
    process.env.SEARCH_MODEL_PROVIDER = "alibaba";
    process.env.SEARCH_MODEL_API_KEY = "sk-search-existing";
    process.env.VISION_PROVIDER = "alibaba";
    process.env.VISION_API_KEY = "sk-vision-existing";

    const masked = await updateENV({
      ReaderOcrApiKey: "********************",
      SearchModelApiKey: "********************",
      VisionApiKey: "********************",
    });
    expect(masked.error).toBe(false);
    expect(masked.newValues).toEqual({});
    expect(process.env.READER_OCR_API_KEY).toBe("sk-existing");
    expect(process.env.SEARCH_MODEL_API_KEY).toBe("sk-search-existing");
    expect(process.env.VISION_API_KEY).toBe("sk-vision-existing");

    const invalid = await updateENV({
      ReaderOcrProvider: "dashscope",
    });
    expect(invalid.error).toContain("Invalid reader OCR provider.");
    expect(process.env.READER_OCR_PROVIDER).toBe("alibaba");

    const invalidSearchModel = await updateENV({
      SearchModelProvider: "dashscope",
    });
    expect(invalidSearchModel.error).toContain(
      "Invalid search model provider."
    );
    expect(process.env.SEARCH_MODEL_PROVIDER).toBe("alibaba");

    const invalidVision = await updateENV({
      VisionProvider: "dashscope",
    });
    expect(invalidVision.error).toContain("Invalid vision provider.");
    expect(process.env.VISION_PROVIDER).toBe("alibaba");
  });

  it("does not persist or import the encryption master key through provider backups", () => {
    const {
      exportProviderSettingsBackup,
      importProviderSettingsBackup,
      persistProviderSettingsBackup,
      PROVIDER_ENV_KEYS,
    } = loadUpdateENV();
    const originalMasterKey =
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const importedMasterKey =
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    process.env.ENCRYPTION_MASTER_KEY = originalMasterKey;
    process.env.LLM_PROVIDER = "deepseek";
    process.env.VECTOR_DB = "lancedb";

    expect(PROVIDER_ENV_KEYS).not.toContain("ENCRYPTION_MASTER_KEY");

    const persisted = persistProviderSettingsBackup();
    expect(persisted.success).toBe(true);
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
    expect(backup.values.ENCRYPTION_MASTER_KEY).toBeUndefined();

    const exported = exportProviderSettingsBackup();
    expect(exported.values.ENCRYPTION_MASTER_KEY).toBeUndefined();

    const imported = importProviderSettingsBackup({
      values: {
        ENCRYPTION_MASTER_KEY: importedMasterKey,
        LLM_PROVIDER: "deepseek",
      },
    });
    expect(imported.success).toBe(true);
    expect(process.env.ENCRYPTION_MASTER_KEY).toBe(originalMasterKey);
  });

  it("does not rewrite the env file when backup values are unchanged", () => {
    const { hydrateProviderSettingsBackup, persistProviderSettingsBackup } =
      loadUpdateENV();
    process.env.LLM_PROVIDER = "deepseek";
    process.env.VECTOR_DB = "lancedb";

    expect(persistProviderSettingsBackup().success).toBe(true);
    const originalContent = "# operator-managed environment\n";
    fs.writeFileSync(envPath, originalContent, "utf8");

    const result = hydrateProviderSettingsBackup();

    expect(result.success).toBe(true);
    expect(result.applied).toEqual({});
    expect(result.skipped).toMatchObject({
      LLM_PROVIDER: "unchanged",
      VECTOR_DB: "unchanged",
    });
    expect(fs.readFileSync(envPath, "utf8")).toBe(originalContent);
  });
});
