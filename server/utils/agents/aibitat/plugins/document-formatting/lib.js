const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const { XMLBuilder, XMLParser } = require("fast-xml-parser");
const { lazyDataAccessFacade } = require("../../../../dataAccess/lazyFacade");
const { safeJsonParse } = require("../../../../http");
const {
  directUploadsPath,
  isWithin,
  readDocumentJsonFile,
} = require("../../../../files");
const {
  readDocxSource,
  sourceTokenFromMetadata,
} = require("../../../../documentSources");
const {
  WorkspaceChatRepository: WorkspaceChats,
} = require("../../../../../repositories/workspaceChatRepository");
const createFilesLib = require("../create-files/lib");
const {
  DEFAULT_NUMBERING_CONFIG,
  getMargins,
  getTheme,
  htmlToDocxElements,
} = require("../create-files/docx/utils");

const WorkspaceParsedFiles = lazyDataAccessFacade("workspaceParsedFile");
const Document = lazyDataAccessFacade("document");
const MAX_DOCX_BYTES = 50 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5_000;
const XML_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: false,
};

const PROFILE_STYLES = {
  professional: {
    bodySize: 22,
    headingSizes: [36, 32, 28, 24, 22, 22],
    line: 360,
    after: 160,
  },
  academic: {
    bodySize: 24,
    headingSizes: [36, 32, 28, 26, 24, 24],
    line: 480,
    after: 120,
  },
  minimal: {
    bodySize: 21,
    headingSizes: [32, 28, 26, 24, 22, 21],
    line: 300,
    after: 120,
  },
};

const FONT_SETS = {
  "zh-CN": {
    // Noto Sans SC is bundled with the server and gives deterministic CJK
    // coverage in native, container, and headless verification environments.
    body: "Noto Sans SC",
    bodyEastAsia: "Noto Sans SC",
    heading: "Noto Sans SC",
    headingEastAsia: "Noto Sans SC",
  },
  ja: {
    body: "Yu Gothic",
    bodyEastAsia: "游ゴシック",
    heading: "Yu Gothic",
    headingEastAsia: "游ゴシック",
  },
  en: {
    body: "Aptos",
    bodyEastAsia: "Aptos",
    heading: "Aptos Display",
    headingEastAsia: "Aptos Display",
  },
};

function safeSourceIdentifier(value = "") {
  const source = String(value || "").trim();
  if (!source || source.length > 512) return null;
  if (path.isAbsolute(source) || /^[a-zA-Z]:[\\/]/.test(source)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return null;
  if (source.split(/[\\/]+/).some((part) => part === "..")) return null;
  return source;
}

function normalizeOutputFilename(filename, sourceName = "document.docx") {
  const sourceBase = path.basename(String(sourceName || "document.docx"));
  const fallback = `formatted-${sourceBase.replace(/\.docx$/i, "")}.docx`;
  const requested =
    path.basename(String(filename || fallback).trim()) || fallback;
  const normalized = requested.replace(/[\r\n"\\]/g, "_").slice(0, 200);
  return /\.docx$/i.test(normalized) ? normalized : `${normalized}.docx`;
}

function metadataMatches(record, identifier) {
  const metadata = safeJsonParse(record?.metadata, {});
  const values = [
    record?.id,
    record?.filename,
    metadata?.title,
    metadata?.location,
    path.basename(String(metadata?.location || "")),
    metadata?.docxSource?.originalName,
  ];
  return values.some((value) => String(value || "").trim() === identifier);
}

function parsedContent(record) {
  const metadata = safeJsonParse(record?.metadata, {});
  const location = path.basename(String(metadata?.location || ""));
  if (!location) return null;
  const sourcePath = path.resolve(directUploadsPath, location);
  if (!isWithin(directUploadsPath, sourcePath) || !fs.existsSync(sourcePath))
    return null;
  try {
    return readDocumentJsonFile(sourcePath)?.pageContent || null;
  } catch {
    return null;
  }
}

async function parsedFileCandidates(context, identifier) {
  const workspaceId = context.workspace?.id;
  if (!workspaceId) return [];
  const records = await WorkspaceParsedFiles.where({
    workspaceId,
    ...(context.user?.id ? { userId: context.user.id } : {}),
    ...(context.thread?.id ? { threadId: context.thread.id } : {}),
  });
  return records.filter((record) => metadataMatches(record, identifier));
}

function outputMatches(output, identifier) {
  return [
    output?.payload?.storageFilename,
    output?.payload?.filename,
    output?.payload?.displayFilename,
  ].some((value) => String(value || "").trim() === identifier);
}

async function generatedFileCandidates(context, identifier) {
  const workspaceId = context.workspace?.id;
  if (!workspaceId) return [];
  const chats = await WorkspaceChats.where({
    workspaceId,
    include: true,
    response: { contains: identifier },
  });
  const candidates = [];
  for (const chat of chats || []) {
    const response = safeJsonParse(chat.response, {});
    for (const output of response.outputs || []) {
      if (!outputMatches(output, identifier)) continue;
      const storageFilename = output?.payload?.storageFilename;
      if (!/^docx-[0-9a-f-]{36}\.docx$/i.test(storageFilename || "")) continue;
      const file = await createFilesLib.getGeneratedFile(storageFilename);
      if (!file) continue;
      candidates.push({
        kind: "generated",
        displayName:
          output.payload.filename ||
          output.payload.displayFilename ||
          storageFilename,
        buffer: file.buffer,
        content: null,
      });
    }
  }
  return candidates;
}

async function documentCandidates(context, identifier) {
  const workspaceId = context.workspace?.id;
  if (!workspaceId) return [];
  const documents = await Document.where({ workspaceId });
  const matches = (documents || []).filter((document) =>
    [document.docId, document.filename, document.docpath]
      .filter(Boolean)
      .some((value) => String(value).trim() === identifier)
  );
  return await Promise.all(
    matches.map(async (document) => {
      const content = await Document.content(document.docId);
      return {
        kind: "document",
        displayName: document.filename || path.basename(document.docpath),
        buffer: null,
        content: content?.content || null,
      };
    })
  );
}

async function resolveDocumentSource(aibitat, source) {
  const identifier = safeSourceIdentifier(source);
  if (!identifier) throw new Error("invalid_document_source");
  const access = aibitat?.handlerProps?.fileAccessContext || {};
  const invocation =
    aibitat?.handlerProps?.invocation || access.invocation || {};
  const context = {
    workspace: access.workspace || invocation.workspace || null,
    user:
      access.user || (invocation.user_id ? { id: invocation.user_id } : null),
    thread:
      access.thread ||
      (invocation.thread_id ? { id: invocation.thread_id } : null),
  };
  if (!context.workspace?.id) throw new Error("workspace_context_required");

  const [parsed, generated, documents] = await Promise.all([
    parsedFileCandidates(context, identifier),
    generatedFileCandidates(context, identifier),
    documentCandidates(context, identifier),
  ]);
  const candidates = [];
  for (const record of parsed) {
    const token = sourceTokenFromMetadata(record.metadata);
    candidates.push({
      kind: "parsed_file",
      displayName:
        safeJsonParse(record.metadata, {})?.docxSource?.originalName ||
        safeJsonParse(record.metadata, {})?.title ||
        record.filename,
      buffer: token ? readDocxSource(token) : null,
      content: parsedContent(record),
    });
  }
  candidates.push(...generated, ...documents);

  const usable = candidates.filter(
    (candidate) => candidate.buffer || candidate.content
  );
  if (usable.length === 0) throw new Error("document_source_not_found");
  if (usable.length > 1) throw new Error("ambiguous_document_source");
  return usable[0];
}

function validateDocxPackage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0)
    throw new Error("docx_source_empty");
  if (buffer.length > MAX_DOCX_BYTES) throw new Error("docx_source_too_large");
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b)
    throw new Error("invalid_docx_package");

  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new Error("invalid_docx_package");
  }
  const entries = zip.getEntries();
  if (entries.length === 0 || entries.length > MAX_ZIP_ENTRIES)
    throw new Error("unsafe_docx_archive");

  let uncompressedBytes = 0;
  for (const entry of entries) {
    const name = String(entry.entryName || "").replace(/\\/g, "/");
    if (!name || name.startsWith("/") || name.split("/").includes(".."))
      throw new Error("unsafe_docx_archive");
    if (entry.header?.flags & 0x1)
      throw new Error("encrypted_docx_not_supported");
    uncompressedBytes += Number(entry.header?.size || 0);
    if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES)
      throw new Error("unsafe_docx_archive");
    if (
      /^(word\/(vbaProject\.bin|activeX\/|embeddings\/)|EncryptedPackage|EncryptionInfo)/i.test(
        name
      )
    )
      throw new Error("active_docx_content_not_supported");
  }

  const contentTypes = zip.readAsText("[Content_Types].xml");
  const documentXml = zip.readAsText("word/document.xml");
  const stylesXml = zip.readAsText("word/styles.xml");
  if (!contentTypes || !documentXml || !stylesXml)
    throw new Error("invalid_docx_package");
  if (/macroEnabled|vbaProject|ActiveX|oleObject/i.test(contentTypes))
    throw new Error("active_docx_content_not_supported");
  const settingsRelationships = zip.readAsText("word/_rels/settings.xml.rels");
  if (/attachedTemplate/i.test(settingsRelationships || ""))
    throw new Error("external_template_not_supported");
  return { zip, documentXml, stylesXml };
}

function detectLanguage(documentXml, requested = "auto") {
  if (requested !== "auto") return requested;
  const text = String(documentXml || "").replace(/<[^>]+>/g, "");
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\u3400-\u9fff]/.test(text)) return "zh-CN";
  return "en";
}

function ensureArray(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function runFonts(fonts) {
  return {
    "@_w:ascii": fonts.body,
    "@_w:hAnsi": fonts.body,
    "@_w:eastAsia": fonts.bodyEastAsia,
    "@_w:cs": fonts.body,
  };
}

function styleFonts(fonts, heading = false) {
  const western = heading ? fonts.heading : fonts.body;
  const eastAsia = heading ? fonts.headingEastAsia : fonts.bodyEastAsia;
  return {
    "@_w:ascii": western,
    "@_w:hAnsi": western,
    "@_w:eastAsia": eastAsia,
    "@_w:cs": western,
  };
}

function xmlWithDeclaration(xml) {
  return xml.startsWith("<?xml")
    ? xml
    : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${xml}`;
}

function formatStylesXml(stylesXml, { profile, language }) {
  const parser = new XMLParser(XML_OPTIONS);
  const rootObject = parser.parse(stylesXml);
  const root = rootObject["w:styles"];
  if (!root) throw new Error("invalid_docx_styles");
  const profileStyle = PROFILE_STYLES[profile] || PROFILE_STYLES.professional;
  const fonts = FONT_SETS[language] || FONT_SETS.en;

  root["w:docDefaults"] = root["w:docDefaults"] || {};
  root["w:docDefaults"]["w:rPrDefault"] = {
    "w:rPr": {
      "w:rFonts": runFonts(fonts),
      "w:sz": { "@_w:val": String(profileStyle.bodySize) },
      "w:szCs": { "@_w:val": String(profileStyle.bodySize) },
      "w:lang": {
        "@_w:val": language === "en" ? "en-US" : language,
        "@_w:eastAsia": language,
      },
    },
  };
  root["w:docDefaults"]["w:pPrDefault"] = {
    "w:pPr": {
      "w:spacing": {
        "@_w:after": String(profileStyle.after),
        "@_w:line": String(profileStyle.line),
        "@_w:lineRule": "auto",
      },
      "w:widowControl": "",
    },
  };

  const styles = ensureArray(root["w:style"]);
  for (const style of styles) {
    const styleId = String(style?.["@_w:styleId"] || "");
    const name = String(style?.["w:name"]?.["@_w:val"] || "");
    const headingMatch = `${styleId} ${name}`.match(/heading\s*([1-6])/i);
    const isTitle = /(^|\s)title($|\s)/i.test(`${styleId} ${name}`);
    const isNormal =
      /^(normal|body text)$/i.test(styleId) ||
      /^(normal|body text)$/i.test(name);
    if (!headingMatch && !isTitle && !isNormal) continue;

    const headingLevel = headingMatch ? Number(headingMatch[1]) : null;
    const size = isTitle
      ? profileStyle.headingSizes[0] + 8
      : headingLevel
        ? profileStyle.headingSizes[headingLevel - 1]
        : profileStyle.bodySize;
    style["w:rPr"] = style["w:rPr"] || {};
    style["w:rPr"]["w:rFonts"] = styleFonts(
      fonts,
      Boolean(headingLevel || isTitle)
    );
    style["w:rPr"]["w:sz"] = { "@_w:val": String(size) };
    style["w:rPr"]["w:szCs"] = { "@_w:val": String(size) };
    delete style["w:rPr"]["w:highlight"];
    delete style["w:rPr"]["w:shd"];
    delete style["w:rPr"]["w:spacing"];
    delete style["w:rPr"]["w:position"];
    delete style["w:rPr"]["w:kern"];
    style["w:rPr"]["w:color"] = {
      "@_w:val": headingLevel || isTitle ? "1F4E79" : "1F2937",
    };
    style["w:pPr"] = style["w:pPr"] || {};
    style["w:pPr"]["w:spacing"] = {
      "@_w:before": headingLevel || isTitle ? "240" : "0",
      "@_w:after": String(headingLevel || isTitle ? 120 : profileStyle.after),
      "@_w:line": String(profileStyle.line),
      "@_w:lineRule": "auto",
    };
    style["w:pPr"]["w:widowControl"] = "";
    if (headingLevel || isTitle) style["w:pPr"]["w:keepNext"] = "";
  }
  root["w:style"] = styles;

  const builder = new XMLBuilder({
    ...XML_OPTIONS,
    format: false,
    suppressEmptyNode: true,
  });
  return xmlWithDeclaration(builder.build(rootObject));
}

function replaceTagAttributes(xml, tagName, attributes) {
  const pattern = new RegExp(`<${tagName}\\b([^>]*)\\/?>`, "g");
  return xml.replace(pattern, (tag, rawAttributes) => {
    let next = rawAttributes.replace(/\/\s*$/, "");
    for (const [name, value] of Object.entries(attributes)) {
      const attrPattern = new RegExp(`\\s${name}="[^"]*"`, "i");
      next = attrPattern.test(next)
        ? next.replace(attrPattern, ` ${name}="${value}"`)
        : `${next} ${name}="${value}"`;
    }
    return `<${tagName}${next.trim() ? ` ${next.trim()}` : ""}/>`;
  });
}

function removeDirectTag(xml, tagName) {
  const paired = new RegExp(
    `<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`,
    "gi"
  );
  const selfClosing = new RegExp(`<${tagName}\\b[^>]*/>`, "gi");
  return xml.replace(paired, "").replace(selfClosing, "");
}

function decodeXmlText(value = "") {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16))
    )
    .replace(/&#([0-9]+);/g, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 10))
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function encodeXmlText(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function paragraphText(paragraphXml = "") {
  return Array.from(
    String(paragraphXml).matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi),
    (match) => decodeXmlText(match[1])
  ).join("");
}

function sentenceChunks(text, targetLength = 220, maxLength = 360) {
  const sentences =
    String(text).match(/[^。！？!?；;]+(?:[。！？!?；;]+|$)/g) || [];
  if (sentences.length < 6) return [];
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > maxLength) {
      chunks.push(current);
      current = sentence;
      continue;
    }
    current += sentence;
    if (current.length >= targetLength) {
      chunks.push(current);
      current = "";
    }
  }
  if (current) {
    if (chunks.length && current.length < 60)
      chunks[chunks.length - 1] += current;
    else chunks.push(current);
  }
  return chunks.length > 1 ? chunks : [];
}

function segmentLongParagraphs(documentXml) {
  let segmentedParagraphs = 0;
  const xml = documentXml.replace(
    /<w:p\b([^>]*)>([\s\S]*?)<\/w:p>/gi,
    (paragraph, attributes, contents) => {
      const text = paragraphText(paragraph);
      if (text.length < 500) return paragraph;
      if (
        /<w:(?:drawing|pict|object|hyperlink|fldSimple|instrText|bookmarkStart|bookmarkEnd|commentRangeStart|commentRangeEnd|commentReference|footnoteReference|endnoteReference|tab|br|sectPr|sdt|del|ins|sym)\b/i.test(
          contents
        )
      )
        return paragraph;
      const chunks = sentenceChunks(text);
      if (chunks.length < 2) return paragraph;
      const pPr = contents.match(/<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/i)?.[0] || "";
      segmentedParagraphs += chunks.length - 1;
      return chunks
        .map(
          (chunk) =>
            `<w:p${attributes}>${pPr}<w:r><w:t xml:space="preserve">${encodeXmlText(
              chunk
            )}</w:t></w:r></w:p>`
        )
        .join("");
    }
  );
  return { xml, segmentedParagraphs };
}

function normalizeRunProperties(documentXml) {
  const directRunTags = [
    "w:rFonts",
    "w:color",
    "w:highlight",
    "w:shd",
    "w:sz",
    "w:szCs",
    "w:spacing",
    "w:position",
    "w:kern",
  ];
  return documentXml.replace(
    /<w:rPr\b([^>]*)>([\s\S]*?)<\/w:rPr>/gi,
    (match, attributes, contents) => {
      let normalized = contents;
      for (const tag of directRunTags)
        normalized = removeDirectTag(normalized, tag);
      return normalized.trim()
        ? `<w:rPr${attributes}>${normalized}</w:rPr>`
        : "";
    }
  );
}

function normalizeParagraphProperties(documentXml, profile) {
  const profileStyle = PROFILE_STYLES[profile] || PROFILE_STYLES.professional;
  return documentXml.replace(
    /<w:p\b([^>]*)>([\s\S]*?)<\/w:p>/gi,
    (paragraph, paragraphAttributes, paragraphContents) => {
      const propertyMatch = paragraphContents.match(
        /<w:pPr\b([^>]*)>([\s\S]*?)<\/w:pPr>/i
      );
      const attributes = propertyMatch?.[1] || "";
      const contents = propertyMatch?.[2] || "";
      const text = paragraphText(paragraph).trim();
      const isHeading = /<w:pStyle\b[^>]*w:val="(?:Title|Heading[1-6])"/i.test(
        contents
      );
      const isQuestion = /^(?:第\s*)?\d{1,3}\s*[.．、)]/.test(text);
      const isOption = /^[A-HＡ-Ｈ]\s*[.．、)]/.test(text);
      let normalized = contents;
      for (const tag of ["w:ind", "w:spacing", "w:jc", "w:shd"])
        normalized = removeDirectTag(normalized, tag);
      normalized += `<w:spacing w:before="0" w:after="${
        isHeading ? 120 : profileStyle.after
      }" w:line="${profileStyle.line}" w:lineRule="auto"/>`;
      if (isHeading) normalized += "<w:keepNext/>";
      else {
        normalized += '<w:jc w:val="left"/>';
        if (isOption) normalized += '<w:ind w:left="480" w:hanging="0"/>';
        else if (isQuestion)
          normalized += '<w:ind w:left="0" w:hanging="0"/><w:keepNext/>';
        else if (text) normalized += '<w:ind w:firstLine="440"/>';
      }
      const nextProperties = `<w:pPr${attributes}>${normalized}</w:pPr>`;
      const body = propertyMatch
        ? paragraphContents.replace(propertyMatch[0], nextProperties)
        : `${nextProperties}${paragraphContents}`;
      return `<w:p${paragraphAttributes}>${body}</w:p>`;
    }
  );
}

function normalizeTableFormatting(documentXml) {
  let output = removeDirectTag(documentXml, "w:shd");
  output = output.replace(
    /<w:tblPr\b([^>]*)>([\s\S]*?)<\/w:tblPr>/gi,
    (match, attributes, contents) => {
      const withoutStyle = removeDirectTag(contents, "w:tblStyle");
      return `<w:tblPr${attributes}><w:tblStyle w:val="TableGrid"/>${withoutStyle}</w:tblPr>`;
    }
  );
  return output;
}

function formatDocumentXml(documentXml, { pageSize, margins, profile }) {
  let output = documentXml;
  const segmentation = segmentLongParagraphs(output);
  output = segmentation.xml;
  if (pageSize === "A4")
    output = replaceTagAttributes(output, "w:pgSz", {
      "w:w": "11906",
      "w:h": "16838",
    });
  if (pageSize === "Letter")
    output = replaceTagAttributes(output, "w:pgSz", {
      "w:w": "12240",
      "w:h": "15840",
    });
  if (margins !== "preserve") {
    const marginConfig = getMargins(margins);
    output = replaceTagAttributes(output, "w:pgMar", {
      "w:top": String(marginConfig.top),
      "w:right": String(marginConfig.right),
      "w:bottom": String(marginConfig.bottom),
      "w:left": String(marginConfig.left),
    });
  }
  output = normalizeRunProperties(output);
  output = normalizeParagraphProperties(output, profile);
  output = normalizeTableFormatting(output);
  return { xml: output, segmentedParagraphs: segmentation.segmentedParagraphs };
}

function formatDocxBuffer(buffer, options = {}) {
  const { zip, documentXml, stylesXml } = validateDocxPackage(buffer);
  const language = detectLanguage(documentXml, options.language || "auto");
  const formattedStyles = formatStylesXml(stylesXml, {
    profile: options.profile || "professional",
    language,
  });
  const formattedDocument = formatDocumentXml(documentXml, {
    pageSize: options.pageSize || "preserve",
    margins: options.margins || "preserve",
    profile: options.profile || "professional",
  });
  zip.updateFile("word/styles.xml", Buffer.from(formattedStyles, "utf8"));
  zip.updateFile(
    "word/document.xml",
    Buffer.from(formattedDocument.xml, "utf8")
  );
  return {
    buffer: zip.toBuffer(),
    language,
    segmentedParagraphs: formattedDocument.segmentedParagraphs,
  };
}

async function rebuildDocxFromContent(content, options = {}) {
  const markedModule = require("marked");
  const { JSDOM } = require("jsdom");
  const docx = require("docx");
  const libs = {
    marked: markedModule.marked || markedModule,
    JSDOM,
    docx,
  };
  const { marked } = libs;
  const { Document: DocxDocument, Packer, Paragraph, TextRun } = docx;
  marked.setOptions({ gfm: true, breaks: true });
  const html = marked.parse(String(content || ""));
  const theme = getTheme(
    options.profile === "professional" ? "blue" : "neutral"
  );
  const elements = await htmlToDocxElements(
    html,
    libs,
    options.log || (() => {}),
    theme
  );
  if (elements.length === 0)
    elements.push(
      new Paragraph({ children: [new TextRun(String(content || ""))] })
    );
  const doc = new DocxDocument({
    numbering: DEFAULT_NUMBERING_CONFIG,
    sections: [
      {
        properties: {
          page: {
            margin:
              options.margins === "preserve"
                ? getMargins("normal")
                : getMargins(options.margins),
          },
        },
        children: elements,
      },
    ],
  });
  return await Packer.toBuffer(doc);
}

module.exports = {
  MAX_DOCX_BYTES,
  formatDocxBuffer,
  normalizeOutputFilename,
  rebuildDocxFromContent,
  resolveDocumentSource,
  safeSourceIdentifier,
  validateDocxPackage,
};
