const {
  detectProfile,
} = require("../../../utils/knowledgeGraph/workspaceProfileBuilder");

describe("WorkspaceProfileBuilder rules", () => {
  it("detects book-like workspaces from a dominant structured document", () => {
    const result = detectProfile({
      docs: [
        {
          filename: "西方哲学史.md",
          charCount: 100_000,
          sample: "目录\n第一章 希腊哲学\n第二章 柏拉图",
        },
        { filename: "摘录.md", charCount: 2_000, sample: "笔记" },
      ],
    });
    expect(result.profileType).toBe("book");
  });

  it("does not force many short notes into book mode", () => {
    const docs = Array.from({ length: 8 }, (_, index) => ({
      filename: `idea-${index}.md`,
      charCount: 800,
      sample: "零散想法 问答 摘录",
    }));
    const result = detectProfile({ docs });
    expect(result.profileType).toBe("loose_notes");
  });
});
