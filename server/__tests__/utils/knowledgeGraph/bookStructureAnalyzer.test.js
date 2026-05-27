const {
  detectStructure,
} = require("../../../utils/knowledgeGraph/bookStructureAnalyzer");

describe("BookStructureAnalyzer rules", () => {
  it("detects person-driven books when people dominate", () => {
    const result = detectStructure({
      docs: [
        {
          filename: "西方哲学史.md",
          sample: "哲学家 苏格拉底 柏拉图 亚里士多德 人物 思想家",
        },
      ],
      entityCounts: { person: 20, concept: 8 },
    });
    expect(result.structureType).toBe("person_driven");
  });

  it("detects method-driven books for method and exercise language", () => {
    const result = detectStructure({
      docs: [
        {
          filename: "数学方法.md",
          sample: "方法 步骤 公式 练习 示例 前置条件",
        },
      ],
      entityCounts: { method: 10, concept: 8 },
    });
    expect(result.structureType).toBe("method_driven");
  });
});
