/* eslint-env jest */
const fs = require("fs");
const os = require("os");
const path = require("path");

describe("market data provider secret settings", () => {
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
      ENCRYPTION_MASTER_KEY:
        "7f90b83cf42e24978d97e68a78ad1651d1fae113ee93e47044c4152be4c9a133",
      ATHENA_SECRET_ENVELOPE_VERSION: "v2",
    };
    return require("../../../utils/helpers/updateENV");
  }

  beforeEach(() => {
    storageDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "anythingllm-market-secrets-")
    );
    envPath = path.join(storageDir, ".env");
    fs.writeFileSync(envPath, "", { encoding: "utf8", mode: 0o600 });
  });

  afterEach(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  it("encrypts three plaintext credentials in env and the controlled backup", async () => {
    const { PROVIDER_SETTING_KEYS, updateENV } = loadUpdateENV();
    const plaintext = {
      QWeatherApiKey: "qweather-plaintext-test-value",
      JuheStockApiKey: "juhe-stock-plaintext-test-value",
      JuheForexApiKey: "juhe-forex-plaintext-test-value",
    };
    expect(PROVIDER_SETTING_KEYS).toEqual(
      expect.arrayContaining(Object.keys(plaintext))
    );

    const { newValues, error } = await updateENV(plaintext);
    expect(error).toBe(false);
    for (const value of Object.values(newValues))
      expect(value).toMatch(/^enc:v2:/);

    const envContents = fs.readFileSync(envPath, "utf8");
    expect(envContents).toContain("QWEATHER_API_KEY_ENCRYPTED='enc:v2:");
    expect(envContents).toContain("JUHE_STOCK_API_KEY_ENCRYPTED='enc:v2:");
    expect(envContents).toContain("JUHE_FOREX_API_KEY_ENCRYPTED='enc:v2:");
    for (const value of Object.values(plaintext))
      expect(envContents).not.toContain(value);
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);

    const backupPath = path.join(
      storageDir,
      "production",
      "system",
      "provider-settings.backup.json"
    );
    const backupContents = fs.readFileSync(backupPath, "utf8");
    for (const value of Object.values(plaintext))
      expect(backupContents).not.toContain(value);
    const backup = JSON.parse(backupContents);
    expect(backup.values).toMatchObject({
      QWEATHER_API_KEY_ENCRYPTED: expect.stringMatching(/^enc:v2:/),
      JUHE_STOCK_API_KEY_ENCRYPTED: expect.stringMatching(/^enc:v2:/),
      JUHE_FOREX_API_KEY_ENCRYPTED: expect.stringMatching(/^enc:v2:/),
    });
    expect(fs.statSync(backupPath).mode & 0o777).toBe(0o600);
  });

  it("does not replace configured credentials with masked form values", async () => {
    const { updateENV } = loadUpdateENV();
    await updateENV({ QWeatherApiKey: "initial-secret" });
    const before = process.env.QWEATHER_API_KEY_ENCRYPTED;
    const result = await updateENV({ QWeatherApiKey: "********************" });
    expect(result).toEqual({ newValues: {}, error: false });
    expect(process.env.QWEATHER_API_KEY_ENCRYPTED).toBe(before);
  });
});
