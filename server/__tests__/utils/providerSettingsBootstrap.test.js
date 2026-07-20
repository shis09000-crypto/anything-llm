const {
  filterSettingsBySections,
} = require("../../utils/providerSettingsBootstrap");

describe("provider settings bootstrap projection", () => {
  const settings = {
    lastUpdatedAt: "2026-07-20T00:00:00.000Z",
    openAiKey: "sealed",
    vectorDb: "lancedb",
    readerOcrProvider: "native",
    unrelatedSetting: true,
  };

  test("returns the complete projection when no section filter is supplied", () => {
    expect(filterSettingsBySections(settings, [])).toBe(settings);
    expect(filterSettingsBySections(settings, ["all"])).toBe(settings);
  });

  test("projects only requested provider sections and the revision marker", () => {
    expect(filterSettingsBySections(settings, ["vector", "ocr"])).toEqual({
      lastUpdatedAt: settings.lastUpdatedAt,
      vectorDb: "lancedb",
      readerOcrProvider: "native",
    });
  });

  test("matches section names case-insensitively without leaking unrelated values", () => {
    expect(filterSettingsBySections(settings, ["LLM"])).toEqual({
      lastUpdatedAt: settings.lastUpdatedAt,
      openAiKey: "sealed",
    });
  });
});
