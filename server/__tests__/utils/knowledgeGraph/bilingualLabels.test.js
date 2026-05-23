const {
  firstChineseAlias,
  normalizeAliasPairs,
  normalizeLabelResult,
} = require("../../../utils/knowledgeGraph/bilingualLabels");

describe("knowledge graph bilingual labels", () => {
  it("normalizes string and bilingual alias objects", () => {
    expect(
      normalizeAliasPairs([
        "heterochromatin",
        "异染色质",
        { en: "classical heterochromatin", zh: "经典异染色质" },
      ])
    ).toEqual([
      { en: "heterochromatin" },
      { zh: "异染色质" },
      { en: "classical heterochromatin", zh: "经典异染色质" },
    ]);
  });

  it("repairs and normalizes bilingual label JSON", () => {
    const labels = normalizeLabelResult(
      `
      {
        displayNameZh: "染色质重塑",
        displayNameEn: "Chromatin remodeling",
        aliases: [{ en: "remodeling", zh: "重塑" }]
      }
      `,
      "Chromatin remodeling"
    );

    expect(labels).toEqual({
      displayNameZh: "染色质重塑",
      displayNameEn: "Chromatin remodeling",
      aliases: [{ en: "remodeling", zh: "重塑" }],
    });
  });

  it("can infer a Chinese display fallback from aliases", () => {
    expect(firstChineseAlias(["heterochromatin", "异染色质"])).toBe("异染色质");
    expect(firstChineseAlias([{ en: "HP1", zh: "异染色质蛋白 1" }])).toBe(
      "异染色质蛋白 1"
    );
  });
});
