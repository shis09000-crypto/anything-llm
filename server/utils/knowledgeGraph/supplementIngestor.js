const fs = require("fs");
const path = require("path");
const { CollectorApi } = require("../collectorApi");
const {
  DocumentRepository: Document,
} = require("../../repositories/documentRepository");
const { hotdirPath, sanitizeFileName, normalizePath } = require("../files");
const {
  STRUCTURE_JSON_REQUIRED_FIELDS,
  normalizeScopeType,
  normalizeSupplementKind,
} = require("./supplementConstants");

function nowIso() {
  return new Date().toISOString();
}

function timestampPart(date = new Date()) {
  const pad = (value, length = 2) => String(value).padStart(length, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    "-",
    pad(date.getMilliseconds(), 3),
  ].join("");
}

function displayTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    " ",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
  ].join("");
}

function slugPart(value = "supplement") {
  return sanitizeFileName(
    normalizePath(String(value || "supplement"))
      .toLowerCase()
      .replace(/^kg:/, "")
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 72)
  );
}

function markdownFrontmatter(metadata = {}) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === "") continue;
    lines.push(`${key}: ${JSON.stringify(value === null ? null : value)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

function buildSupplementMarkdown({ title, text, metadata }) {
  return [
    markdownFrontmatter(metadata),
    "",
    `# ${title || "补充资料"}`,
    "",
    String(text || "").trim(),
    "",
  ].join("\n");
}

function extractJsonBlocks(markdown = "") {
  const text = String(markdown || "")
    .replace(/\r\n/g, "\n")
    .replace(/[｀`]{3,}/g, "```")
    .replace(/｀/g, "`");
  const blocks = [];
  const labeledFenceRe =
    /(?:```|~~~)[ \t]*(?:json|JSON|Json)[^\n]*\n?([\s\S]*?)(?:```|~~~)/g;
  let match;
  while ((match = labeledFenceRe.exec(text))) blocks.push(match[1].trim());

  const unlabeledFenceRe = /(?:```|~~~)[^\n]*\n?([\s\S]*?)(?:```|~~~)/g;
  while ((match = unlabeledFenceRe.exec(text))) {
    const candidate = match[1].trim();
    if (candidate.startsWith("{")) blocks.push(candidate);
  }

  return [...new Set([...blocks, ...extractJsonObjectCandidates(text)])];
}

function extractJsonObjectCandidates(text = "") {
  const candidates = [];
  const source = String(text || "");
  for (
    let start = source.indexOf("{");
    start !== -1;
    start = source.indexOf("{", start + 1)
  ) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(source.slice(start, index + 1).trim());
          break;
        }
      }
    }
  }
  return candidates;
}

function validateParsedStructure(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, error: "JSON 代码块必须是对象。" };
  }
  const hasField = (field) => {
    if (Object.prototype.hasOwnProperty.call(value, field)) return true;
    if (field === "主轴")
      return Object.prototype.hasOwnProperty.call(value, "primaryAxis");
    if (field === "次轴")
      return Object.prototype.hasOwnProperty.call(value, "secondaryAxes");
    return false;
  };
  const missing = STRUCTURE_JSON_REQUIRED_FIELDS.filter(
    (field) => !hasField(field)
  );
  if (missing.length > 0) {
    return {
      valid: false,
      error: `JSON 缺少字段：${missing.join("、")}`,
    };
  }
  return {
    valid: true,
    parsedStructure: {
      ...value,
      primaryAxis: value["主轴"] ?? value.primaryAxis ?? null,
      secondaryAxes: value["次轴"] ?? value.secondaryAxes ?? [],
    },
  };
}

function parseStructureJsonFromMarkdown(markdown = "") {
  const blocks = extractJsonBlocks(markdown);
  if (blocks.length === 0)
    return {
      valid: false,
      error:
        "未找到可解析的 JSON 内容。请粘贴 JSON 代码块，或使用结构 JSON 输入框。",
    };
  let lastError = "";
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block);
      const validation = validateParsedStructure(parsed);
      if (validation.valid) return validation;
      lastError = validation.error;
    } catch (error) {
      lastError = error.message;
    }
  }
  return {
    valid: false,
    error: `JSON 代码块解析失败：${lastError || "格式不正确"}`,
  };
}

async function ensureCollectorOnline() {
  const Collector = new CollectorApi();
  if (!(await Collector.online())) {
    return {
      Collector,
      error: "Document processing API is not online.",
    };
  }
  return { Collector, error: null };
}

async function embedProcessedDocument({
  workspace,
  document,
  userId = null,
  metadata = {},
}) {
  const {
    failedToEmbed = [],
    errors = [],
    documents: embeddedDocuments = [],
  } = await Document.addDocuments(workspace, [document.location], userId, {
    embeddingModeOverride: "batch",
  });
  if (failedToEmbed.length > 0) {
    return {
      success: false,
      error: errors?.[0] || "supplement_embedding_failed",
    };
  }
  const embeddedDocument = embeddedDocuments[0] || null;
  if (!embeddedDocument) {
    return {
      success: false,
      error: "supplement_document_record_not_available",
    };
  }
  return {
    success: true,
    document: {
      id: document.id,
      location: document.location,
      docId: embeddedDocument.docId,
      filename: embeddedDocument.filename,
      docpath: embeddedDocument.docpath,
      metadata,
    },
  };
}

async function processHotdirFile({
  workspace,
  filename,
  userId = null,
  metadata = {},
}) {
  const { Collector, error } = await ensureCollectorOnline();
  if (error) return { success: false, error };
  const result = await Collector.processDocument(filename, metadata);
  if (!result?.success || result?.documents?.length === 0) {
    return {
      success: false,
      error: result?.reason || "supplement_document_processing_failed",
    };
  }
  return await embedProcessedDocument({
    workspace,
    document: result.documents[0],
    userId,
    metadata,
  });
}

async function ingestUploadedSupplementFile({
  workspace,
  file,
  userId = null,
  metadata = {},
}) {
  if (!file?.originalname) {
    return { success: false, error: "file_required" };
  }
  return await processHotdirFile({
    workspace,
    filename: file.filename || file.originalname,
    userId,
    metadata: { ...metadata, title: metadata.title || file.originalname },
  });
}

async function ingestTextSupplement({
  workspace,
  text,
  title = "补充资料",
  userId = null,
  metadata = {},
  allowStructureJsonDowngrade = false,
}) {
  if (!String(text || "").trim()) {
    return { success: false, error: "text_required" };
  }

  const createdAt = metadata.createdAt || nowIso();
  const safeTitle =
    title ||
    metadata.nodeLabel ||
    metadata.documentName ||
    metadata.supplementScope ||
    "补充资料";
  const humanDocumentName = `${safeTitle} - ${displayTimestamp(
    new Date(createdAt)
  )}`;
  const finalMetadata = {
    ...metadata,
    title: safeTitle,
    documentName: humanDocumentName,
    displayTitle: humanDocumentName,
    createdAt,
  };
  let finalKind = normalizeSupplementKind(finalMetadata.supplementKind);
  if (finalKind === "structure_json") {
    const parsed = parseStructureJsonFromMarkdown(text);
    if (!parsed.valid) {
      if (!allowStructureJsonDowngrade) {
        return {
          success: false,
          error: "invalid_structure_json",
          message: parsed.error,
        };
      }
      finalKind = "reading_guide";
      finalMetadata.supplementKind = "reading_guide";
      finalMetadata.structureJsonValidation = {
        valid: false,
        downgradedFrom: "structure_json",
        error: parsed.error,
      };
    } else {
      finalMetadata.parsedStructure = parsed.parsedStructure;
      finalMetadata.structureJsonValidation = { valid: true };
    }
  }

  if (finalMetadata.scopeType) {
    finalMetadata.scopeType = normalizeScopeType(finalMetadata.scopeType);
  }
  finalMetadata.supplementKind = finalKind;

  const filename = `${slugPart(safeTitle)}-${timestampPart(
    new Date(createdAt)
  )}.md`;
  const fullPath = path.resolve(hotdirPath, filename);
  fs.mkdirSync(hotdirPath, { recursive: true });
  fs.writeFileSync(
    fullPath,
    buildSupplementMarkdown({ title, text, metadata: finalMetadata }),
    "utf8"
  );

  const ingest = await processHotdirFile({
    workspace,
    filename,
    userId,
    metadata: {
      title,
      docSource: "workspace knowledge supplement",
      ...finalMetadata,
    },
  });
  if (!ingest.success) return ingest;
  return {
    ...ingest,
    metadata: finalMetadata,
    supplementKind: finalKind,
  };
}

module.exports = {
  ingestUploadedSupplementFile,
  ingestTextSupplement,
  parseStructureJsonFromMarkdown,
  validateParsedStructure,
};
