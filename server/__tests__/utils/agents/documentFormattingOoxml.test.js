/* global describe, it, expect */
const AdmZip = require("adm-zip");
const {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
} = require("docx");
const {
  formatDocxBuffer,
  rebuildDocxFromContent,
  safeSourceIdentifier,
  validateDocxPackage,
} = require("../../../utils/agents/aibitat/plugins/document-formatting/lib");

async function fixtureDocx() {
  const document = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            text: "中文项目报告",
            heading: HeadingLevel.HEADING_1,
          }),
          new Paragraph("用于验证 DOCX 排版保真的正文。"),
          new Table({
            rows: [
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph("项目")] }),
                  new TableCell({ children: [new Paragraph("状态")] }),
                ],
              }),
            ],
          }),
        ],
      },
    ],
  });
  const buffer = await Packer.toBuffer(document);
  const zip = new AdmZip(buffer);
  zip.addFile("word/comments.xml", Buffer.from("<comments>keep</comments>"));
  zip.addFile("word/media/image1.png", Buffer.from("preserved-image"));
  zip.addFile("word/header1.xml", Buffer.from("<header>keep</header>"));
  return zip.toBuffer();
}

describe("DOCX formatting OOXML pipeline", () => {
  it("updates document styles while preserving untouched package parts", async () => {
    const source = await fixtureDocx();
    const original = Buffer.from(source);
    const before = new AdmZip(source);

    const result = formatDocxBuffer(source, {
      profile: "professional",
      language: "auto",
      pageSize: "A4",
      margins: "normal",
    });
    const after = new AdmZip(result.buffer);

    expect(source).toEqual(original);
    expect(result.language).toBe("zh-CN");
    expect(after.readFile("word/comments.xml")).toEqual(
      before.readFile("word/comments.xml")
    );
    expect(after.readFile("word/media/image1.png")).toEqual(
      before.readFile("word/media/image1.png")
    );
    expect(after.readFile("word/header1.xml")).toEqual(
      before.readFile("word/header1.xml")
    );
    expect(after.readAsText("word/styles.xml")).toContain("Noto Sans SC");
    expect(after.readAsText("word/document.xml")).toContain('w:w="11906"');
    expect(() => validateDocxPackage(result.buffer)).not.toThrow();
  });

  it("normalizes chaotic direct formatting without changing document parts", async () => {
    const source = await fixtureDocx();
    const zip = new AdmZip(source);
    const documentXml = zip.readAsText("word/document.xml");
    zip.updateFile(
      "word/document.xml",
      Buffer.from(
        documentXml
          .replace(
            "<w:rPr>",
            '<w:rPr><w:rFonts w:ascii="Comic Sans MS" w:eastAsia="SimSun"/><w:color w:val="FF00FF"/><w:sz w:val="60"/>'
          )
          .replace(
            "<w:pPr>",
            '<w:pPr><w:ind w:left="5000"/><w:spacing w:before="900"/><w:jc w:val="right"/>'
          ),
        "utf8"
      )
    );

    const result = formatDocxBuffer(zip.toBuffer(), {
      profile: "professional",
      language: "zh-CN",
      pageSize: "A4",
      margins: "normal",
    });
    const formatted = new AdmZip(result.buffer).readAsText(
      "word/document.xml"
    );
    expect(formatted).not.toContain("Comic Sans MS");
    expect(formatted).not.toContain('w:val="FF00FF"');
    expect(formatted).not.toContain('w:left="5000"');
    expect(formatted).not.toContain('w:before="900"');
    expect(formatted).toContain('w:tblStyle w:val="TableGrid"');
  });

  it("aligns question options and safely segments plain wall-of-text paragraphs", async () => {
    const source = await fixtureDocx();
    const zip = new AdmZip(source);
    const documentXml = zip.readAsText("word/document.xml");
    const sentences = Array.from(
      { length: 36 },
      (_, index) => `这是用于验证长段落自动分段的第${index + 1}个完整句子。`
    ).join("");
    const injected = documentXml.replace(
      "<w:sectPr",
      `<w:p><w:r><w:t>1. 以下哪项符合项目要求？</w:t></w:r></w:p><w:p><w:pPr><w:ind w:left="5000"/></w:pPr><w:r><w:t>A. 正确选项</w:t></w:r></w:p><w:p><w:r><w:t>${sentences}</w:t></w:r></w:p><w:sectPr`
    );
    zip.updateFile("word/document.xml", Buffer.from(injected, "utf8"));

    const result = formatDocxBuffer(zip.toBuffer(), {
      profile: "professional",
      language: "zh-CN",
      pageSize: "A4",
      margins: "normal",
    });
    const formatted = new AdmZip(result.buffer).readAsText(
      "word/document.xml"
    );
    const formattedText = Array.from(
      formatted.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g),
      (match) => match[1]
    ).join("");

    expect(result.segmentedParagraphs).toBeGreaterThan(0);
    expect(formattedText).toContain(sentences);
    expect(formatted).toContain('<w:ind w:left="480" w:hanging="0"/>');
    expect(formatted).not.toContain('w:left="5000"');
  });

  it("rejects active document payloads and unsafe source identifiers", async () => {
    const zip = new AdmZip(await fixtureDocx());
    zip.addFile("word/vbaProject.bin", Buffer.from("macro"));
    expect(() => validateDocxPackage(zip.toBuffer())).toThrow(
      "active_docx_content_not_supported"
    );
    expect(
      safeSourceIdentifier("https://example.com/document.docx")
    ).toBeNull();
    expect(safeSourceIdentifier("../../secret.docx")).toBeNull();
    expect(safeSourceIdentifier("report.docx")).toBe("report.docx");
  });

  it("rebuilds a valid DOCX from parsed markdown content", async () => {
    const rebuilt = await rebuildDocxFromContent(
      "# 标题\n\n正文内容\n\n| 项目 | 状态 |\n| --- | --- |\n| A | 完成 |",
      { profile: "academic", language: "zh-CN", margins: "normal" }
    );
    expect(rebuilt.subarray(0, 2).toString("hex")).toBe("504b");
    expect(() => validateDocxPackage(rebuilt)).not.toThrow();
  });
});
