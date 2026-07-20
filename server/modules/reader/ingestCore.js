const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const unzipper = require("unzipper");
const { normalizedExtension } = require("./documentsCore");

const SCHEMA_VERSION = 1;
const ALLOWED_TYPES = {
  ".md": ["text/markdown", "text/plain", "application/octet-stream"],
  ".markdown": ["text/markdown", "text/plain", "application/octet-stream"],
  ".pdf": ["application/pdf", "application/octet-stream"],
  ".docx": [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/octet-stream",
  ],
  ".xlsx": [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/octet-stream",
  ],
  ".epub": ["application/epub+zip", "application/octet-stream"],
};

function documentTypeFromExt(ext) {
  if (ext === ".md" || ext === ".markdown") return "markdown";
  return ext.replace(".", "");
}

function fingerprintForBuffer(buffer) {
  return [
    buffer.length,
    crypto.createHash("sha256").update(buffer).digest("hex"),
  ].join(":");
}

async function fingerprintForFile(filePath) {
  const stat = await fs.promises.stat(filePath);
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, {
      highWaterMark: 1024 * 1024,
    });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return [stat.size, hash.digest("hex")].join(":");
}

function xlsxCellText(value) {
  if (value == null) return "";
  if (typeof value !== "object") return String(value);
  if (value.text) return String(value.text);
  if (value.result != null) return String(value.result);
  if (Array.isArray(value.richText))
    return value.richText.map((part) => part.text || "").join("");
  if (value.hyperlink) return String(value.text || value.hyperlink);
  return String(value);
}

function xmlAttribute(source = "", name = "") {
  const match = String(source).match(
    new RegExp(`${name.replace(":", "\\:")}=["']([^"']*)["']`, "i")
  );
  return match?.[1]
    ?.replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function decodeXmlText(value = "") {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_match, decimal) =>
      String.fromCodePoint(Number.parseInt(decimal, 10))
    )
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

async function xlsxWorkbookMetadata(originalPath) {
  const archive = await unzipper.Open.file(originalPath);
  const workbookEntry = archive.files.find(
    (entry) => entry.path === "xl/workbook.xml"
  );
  const relationshipsEntry = archive.files.find(
    (entry) => entry.path === "xl/_rels/workbook.xml.rels"
  );
  const sharedStringsEntry = archive.files.find(
    (entry) => entry.path === "xl/sharedStrings.xml"
  );
  if (!workbookEntry || !relationshipsEntry) {
    throw new Error("XLSX workbook metadata is incomplete.");
  }
  const maxMetadataBytes = 2 * 1024 * 1024;
  for (const entry of [workbookEntry, relationshipsEntry]) {
    if (Number(entry.vars?.uncompressedSize || 0) > maxMetadataBytes) {
      throw new Error("XLSX workbook metadata exceeds the safety limit.");
    }
  }
  if (
    sharedStringsEntry &&
    Number(sharedStringsEntry.vars?.uncompressedSize || 0) > 64 * 1024 * 1024
  ) {
    throw new Error("XLSX shared strings exceed the safety limit.");
  }
  const [workbookXml, relationshipsXml, sharedStringsXml] = await Promise.all([
    workbookEntry.buffer().then((buffer) => buffer.toString("utf8")),
    relationshipsEntry.buffer().then((buffer) => buffer.toString("utf8")),
    sharedStringsEntry
      ? sharedStringsEntry.buffer().then((buffer) => buffer.toString("utf8"))
      : Promise.resolve(""),
  ]);
  const sheets = [...workbookXml.matchAll(/<sheet\b([^>]*)\/?\s*>/gi)].map(
    (match, index) => ({
      id: Number(xmlAttribute(match[1], "sheetId")) || index + 1,
      name: xmlAttribute(match[1], "name") || `Sheet ${index + 1}`,
      rId: xmlAttribute(match[1], "r:id"),
      state: xmlAttribute(match[1], "state") || "visible",
    })
  );
  const workbookRels = [
    ...relationshipsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi),
  ].map((match) => ({
    Id: xmlAttribute(match[1], "Id"),
    Target: xmlAttribute(match[1], "Target")?.replace(/^\/?xl\//, ""),
    Type: xmlAttribute(match[1], "Type"),
  }));
  const sharedStrings = [
    ...sharedStringsXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi),
  ].map((match) =>
    decodeXmlText(
      [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)]
        .map((textMatch) => textMatch[1])
        .join("")
    )
  );
  return { model: { sheets }, workbookRels, sharedStrings };
}

async function xlsxContentProjection({
  readerDocumentId,
  originalPath,
  maxCells = 100_000,
  maxTextBytes = 8 * 1024 * 1024,
}) {
  const metadata = await xlsxWorkbookMetadata(originalPath);
  const workbook = new ExcelJS.stream.xlsx.WorkbookReader(originalPath, {
    sharedStrings: "cache",
    hyperlinks: "ignore",
    styles: "ignore",
    worksheets: "emit",
  });
  // ExcelJS 4 can encounter a worksheet entry before workbook.xml depending on
  // ZIP entry order. Seed the tiny metadata first so sheet streaming never
  // falls back to loading the full workbook or dereferences an absent model.
  workbook.model = metadata.model;
  workbook.workbookRels = metadata.workbookRels;
  workbook.sharedStrings = metadata.sharedStrings;
  const sheets = [];
  let cellCount = 0;
  let textBytes = 0;
  let truncated = false;
  for await (const worksheet of workbook) {
    const sheet = {
      name: worksheet.name || `Sheet ${sheets.length + 1}`,
      rows: [],
    };
    for await (const row of worksheet) {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      const projected = [];
      for (const value of values) {
        const text = xlsxCellText(value);
        const bytes = Buffer.byteLength(text, "utf8");
        if (cellCount + 1 > maxCells || textBytes + bytes > maxTextBytes) {
          truncated = true;
          break;
        }
        projected.push(text);
        cellCount += 1;
        textBytes += bytes;
      }
      if (projected.length) sheet.rows.push(projected);
      if (truncated) break;
    }
    sheets.push(sheet);
    if (truncated) break;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    readerDocumentId,
    documentType: "xlsx",
    sheets,
    projection: { source: "server", truncated, cellCount, textBytes },
  };
}

function markdownBlocks(text = "") {
  const lines = String(text || "").split(/\r?\n/);
  const blocks = [];
  let buffer = [];
  let index = 0;
  const flush = () => {
    const content = buffer.join("\n").trim();
    if (!content) {
      buffer = [];
      return;
    }
    blocks.push({
      blockId: `block-${index++}`,
      type: /^#{1,6}\s/.test(content) ? "heading" : "paragraph",
      text: content,
    });
    buffer = [];
  };

  for (const line of lines) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^#{1,6}\s/.test(line)) flush();
    buffer.push(line);
  }
  flush();
  return blocks;
}

function contentForUpload({ readerDocumentId, documentType, buffer }) {
  if (documentType === "markdown") {
    const text = buffer.toString("utf8");
    return {
      schemaVersion: SCHEMA_VERSION,
      readerDocumentId,
      documentType,
      blocks: markdownBlocks(text),
    };
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    readerDocumentId,
    documentType,
    ...(documentType === "xlsx" ? { sheets: [] } : {}),
    ...(documentType === "pdf" ? { pages: [] } : {}),
    ...(documentType === "docx" ? { blocks: [] } : {}),
    ...(documentType === "epub" ? { toc: [] } : {}),
  };
}

function parsedWorkspaceContent(readerDocumentId, data = {}) {
  const text = data.pageContent || "";
  return {
    schemaVersion: SCHEMA_VERSION,
    readerDocumentId,
    documentType: "markdown",
    blocks: markdownBlocks(text),
    parsedOnly: true,
  };
}

function mimeForExt(ext) {
  return ALLOWED_TYPES[ext]?.find(
    (type) => type !== "application/octet-stream"
  );
}

function contentAndMetadataForLocalPath({
  readerDocumentId,
  source = "local_path",
  absolutePath,
  buffer,
  stat,
}) {
  const ext = normalizedExtension(absolutePath);
  const documentType = documentTypeFromExt(ext);
  const content = contentForUpload({
    readerDocumentId,
    documentType,
    buffer,
  });
  const metadata = {
    schemaVersion: SCHEMA_VERSION,
    readerDocumentId,
    source,
    originalName: path.basename(absolutePath),
    storedName: null,
    localPath: absolutePath,
    mimeType: mimeForExt(ext) || "application/octet-stream",
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    originalFingerprint: fingerprintForBuffer(buffer),
    createdAt: new Date().toISOString(),
  };

  return { content, metadata };
}

function documentTypeFromMetadata(metadata = {}) {
  const explicit =
    metadata.documentType ||
    metadata.stream?.documentType ||
    metadata.contentSummary?.documentType;
  if (explicit) return explicit;

  const mimeType = String(metadata.mimeType || metadata.stream?.mimeType || "")
    .trim()
    .toLowerCase();
  const ext = normalizedExtension(
    metadata.localPath ||
      metadata.storedName ||
      metadata.originalName ||
      metadata.previewPdfName ||
      ""
  );

  if (mimeType === "application/pdf" || ext === ".pdf") return "pdf";
  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === ".docx"
  )
    return "docx";
  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    ext === ".xlsx"
  )
    return "xlsx";
  if (mimeType === "application/epub+zip" || ext === ".epub") return "epub";
  if (mimeType === "text/markdown" || ext === ".md" || ext === ".markdown")
    return "markdown";
  return null;
}

function metadataIsMarkdown(metadata = {}) {
  try {
    const mimeType = String(metadata.mimeType || "").toLowerCase();
    const ext = normalizedExtension(
      metadata.localPath || metadata.storedName || metadata.originalName || ""
    );
    return (
      documentTypeFromMetadata(metadata) === "markdown" ||
      mimeType === "text/markdown" ||
      ext === ".md" ||
      ext === ".markdown"
    );
  } catch {
    return false;
  }
}

function metadataIsPdf(metadata = {}) {
  try {
    const mimeType = String(metadata.mimeType || "").toLowerCase();
    return (
      mimeType === "application/pdf" ||
      normalizedExtension(
        metadata.localPath || metadata.storedName || metadata.originalName || ""
      ) === ".pdf"
    );
  } catch {
    return false;
  }
}

module.exports = {
  contentAndMetadataForLocalPath,
  contentForUpload,
  documentTypeFromExt,
  documentTypeFromMetadata,
  fingerprintForBuffer,
  fingerprintForFile,
  markdownBlocks,
  metadataIsMarkdown,
  metadataIsPdf,
  mimeForExt,
  parsedWorkspaceContent,
  xlsxContentProjection,
};
