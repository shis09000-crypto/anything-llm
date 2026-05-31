import markdownIt from "markdown-it";
import { READER_SCHEMA_VERSION, stableBlockId, textHash } from "./storage";

const markdown = markdownIt({ html: false, typographer: true });

export function parseMarkdownBlocks(text = "") {
  const tokens = markdown.parse(String(text || ""), {});
  const blocks = [];
  let index = 0;
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (
      [
        "heading_open",
        "paragraph_open",
        "bullet_list_open",
        "ordered_list_open",
      ].includes(token.type)
    ) {
      const type = token.type.replace("_open", "").replace("_list", "List");
      let content = "";
      const level = token.tag?.replace("h", "") || null;
      i += 1;
      while (i < tokens.length && !tokens[i].type.endsWith("_close")) {
        if (tokens[i].type === "inline") content += tokens[i].content;
        if (tokens[i].type === "fence" || tokens[i].type === "code_block")
          content += tokens[i].content;
        i += 1;
      }
      const textValue = content.trim();
      if (textValue) {
        blocks.push({
          blockId: stableBlockId(textValue, index++),
          type,
          level,
          text: textValue,
        });
      }
    }
    if (token.type === "fence" || token.type === "code_block") {
      const textValue = token.content.trim();
      if (textValue) {
        blocks.push({
          blockId: stableBlockId(textValue, index++),
          type: "code",
          text: textValue,
        });
      }
    }
    i += 1;
  }
  return blocks;
}

export async function parseMarkdownFile(file, readerDocumentId) {
  const text = await file.text();
  return {
    schemaVersion: READER_SCHEMA_VERSION,
    readerDocumentId,
    documentType: "markdown",
    blocks: parseMarkdownBlocks(text),
  };
}

export async function parseDocxFile(file, readerDocumentId) {
  const mammoth = await import("mammoth/mammoth.browser");
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.convertToHtml({ arrayBuffer });
  const doc = new DOMParser().parseFromString(result.value || "", "text/html");
  const nodes = [...doc.body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,table")];
  const blocks = nodes
    .map((node, index) => {
      const text = node.textContent?.trim();
      if (!text) return null;
      return {
        blockId: stableBlockId(text, index),
        type: /^H\d$/.test(node.tagName)
          ? "heading"
          : node.tagName === "TABLE"
            ? "table"
            : "paragraph",
        level: /^H\d$/.test(node.tagName)
          ? node.tagName.replace("H", "")
          : null,
        text,
      };
    })
    .filter(Boolean);
  return {
    schemaVersion: READER_SCHEMA_VERSION,
    readerDocumentId,
    documentType: "docx",
    html: result.value || "",
    previewMode: "html-fallback",
    blocks,
  };
}

function encodeCell(colIndex, rowIndex) {
  let col = "";
  let n = colIndex + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    col = String.fromCharCode(65 + rem) + col;
    n = Math.floor((n - 1) / 26);
  }
  return `${col}${rowIndex + 1}`;
}

export async function parseXlsxFile(file, readerDocumentId) {
  const XLSX = await import("xlsx");
  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, { type: "array" });
  const sheets = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      blankrows: false,
    });
    return { name, rows };
  });
  return {
    schemaVersion: READER_SCHEMA_VERSION,
    readerDocumentId,
    documentType: "xlsx",
    sheets,
  };
}

export async function parsePdfFile(_file, readerDocumentId) {
  return {
    schemaVersion: READER_SCHEMA_VERSION,
    readerDocumentId,
    documentType: "pdf",
    pages: [],
  };
}

export async function parseEpubFile(_file, readerDocumentId) {
  return {
    schemaVersion: READER_SCHEMA_VERSION,
    readerDocumentId,
    documentType: "epub",
    toc: [],
  };
}

export function markdownTableFromRange(sheetName, rows, selection) {
  if (!selection) return "";
  const minRow = Math.min(selection.startRow, selection.endRow);
  const maxRow = Math.max(selection.startRow, selection.endRow);
  const minCol = Math.min(selection.startCol, selection.endCol);
  const maxCol = Math.max(selection.startCol, selection.endCol);
  const selectedRows = [];
  for (let rowIndex = minRow; rowIndex <= maxRow; rowIndex += 1) {
    const row = [];
    for (let colIndex = minCol; colIndex <= maxCol; colIndex += 1) {
      row.push(String(rows[rowIndex]?.[colIndex] ?? ""));
    }
    selectedRows.push(row);
  }
  const header = selectedRows[0] || [];
  const body = selectedRows.slice(1);
  const markdownRows = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ];
  const start = encodeCell(minCol, minRow);
  const end = encodeCell(maxCol, maxRow);
  return {
    text: markdownRows.join("\n"),
    range: start === end ? start : `${start}:${end}`,
    sheetName,
  };
}

export function locatorForBlock(block) {
  return {
    blockId: block.blockId,
    selectedText: block.text,
    textHash: textHash(block.text),
  };
}
