const {
  parseStructureJsonFromMarkdown,
} = require("../../../utils/knowledgeGraph/supplementIngestor");
const {
  workspaceSupplementKindLabel,
  workspaceSupplementPromptForKind,
} = require("../../../utils/knowledgeGraph/supplementConstants");

describe("supplementIngestor structure_json parsing", () => {
  it("extracts and validates the required JSON block", () => {
    const result = parseStructureJsonFromMarkdown(`
# 导读

\`\`\`json
{
  "资料类型": "书籍",
  "主文档": "西方哲学史.pdf",
  "主题范围": "哲学史",
  "不讨论范围": [],
  "组织方式": "人物驱动",
  "主轴": "哲学家",
  "次轴": ["概念", "学派"],
  "关键人物": ["柏拉图"],
  "关键概念": ["理念论"],
  "关键问题": ["什么是正义"],
  "关键章节": [],
  "关键方法或论证": [],
  "节点解析标准": {"person": ["问题", "观点"]},
  "推荐偏好": ["主线推进"],
  "禁止误判": ["不要伪造章节"],
  "语言偏好": "中文"
}
\`\`\`
`);

    expect(result.valid).toBe(true);
    expect(result.parsedStructure["主轴"]).toBe("哲学家");
    expect(result.parsedStructure.primaryAxis).toBe("哲学家");
    expect(result.parsedStructure.secondaryAxes).toEqual(["概念", "学派"]);
  });

  it("rejects malformed or incomplete structure_json blocks", () => {
    const result = parseStructureJsonFromMarkdown(`
\`\`\`json
{"资料类型":"书籍"}
\`\`\`
`);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("缺少字段");
  });

  it("accepts common JSON paste variants without strict fenced block syntax", () => {
    const json = `{
  "资料类型": "书籍",
  "主文档": "西方哲学史.pdf",
  "主题范围": "哲学史",
  "不讨论范围": [],
  "组织方式": "人物驱动",
  "主轴": "哲学家",
  "次轴": ["概念"],
  "关键人物": [],
  "关键概念": [],
  "关键问题": [],
  "关键章节": [],
  "关键方法或论证": [],
  "节点解析标准": {},
  "推荐偏好": [],
  "禁止误判": [],
  "语言偏好": "中文"
}`;

    const upperFence = parseStructureJsonFromMarkdown(`说明\n~~~ JSON\n${json}\n~~~`);
    const plainObject = parseStructureJsonFromMarkdown(`说明在前面\n${json}`);

    expect(upperFence.valid).toBe(true);
    expect(plainObject.valid).toBe(true);
    expect(plainObject.parsedStructure.primaryAxis).toBe("哲学家");
  });

  it("returns Chinese labels and kind-specific prompts", () => {
    const structurePrompt = workspaceSupplementPromptForKind("structure_json");
    const conceptPrompt = workspaceSupplementPromptForKind("concept_index");

    expect(workspaceSupplementKindLabel("concept_index")).toBe("概念索引");
    expect(structurePrompt.label).toBe("结构说明");
    expect(structurePrompt.prompt).toContain('"主轴"');
    expect(structurePrompt.prompt).not.toContain("primaryAxis");
    expect(conceptPrompt.prompt).toContain("概念表");
  });
});
