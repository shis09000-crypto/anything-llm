const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const cheerio = require("cheerio");
const ExcelJS = require("exceljs");
const { hashLogValue } = require("../../utils/security/redaction");
const {
  getTaskConnector,
  resolveTaskProviderModel,
} = require("../../utils/llmTasks");
const classificationCore = require("./classificationCore");
const formatReaders = require("./formatReaders");

const CLASSIFICATION_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.READER_CLASSIFICATION_TIMEOUT_MS) || 20_000
);
const CLASSIFICATION_LLM_TEXT_LIMIT = 3_000;
const READER_POSTPROCESS_TEXT_LIMIT = 100_000;

function validNonEmptyFile(filePath) {
  try {
    return fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function optionalRequire(moduleName, searchRoots = []) {
  const roots = [
    ...searchRoots,
    path.resolve(__dirname, ".."),
    path.resolve(__dirname, "../../frontend"),
    path.resolve(__dirname, "../../collector"),
    process.cwd(),
  ];
  for (const root of roots) {
    try {
      return require(require.resolve(moduleName, { paths: [root] }));
    } catch {}
  }
  return null;
}

async function textFromMarkdownFile(originalPath) {
  const accumulator = classificationCore.createClassificationAccumulator();
  return await new Promise((resolve, reject) => {
    let settled = false;
    const stream = fs.createReadStream(originalPath, {
      encoding: "utf8",
      highWaterMark: 64 * 1024,
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(accumulator.text());
    };
    stream.on("data", (chunk) => {
      accumulator.append(chunk);
      if (accumulator.full()) stream.destroy();
    });
    stream.on("close", finish);
    stream.on("end", finish);
    stream.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

async function textFromDocxFile(originalPath) {
  const zip = new AdmZip(originalPath);
  const accumulator = classificationCore.createClassificationAccumulator();
  const xmlNames = [
    "word/document.xml",
    ...zip
      .getEntries()
      .map((entry) => entry.entryName)
      .filter((name) => /^word\/(header|footer)\d+\.xml$/i.test(name)),
  ];
  for (const xmlName of xmlNames) {
    const xml = formatReaders.zipEntryText(zip, xmlName);
    if (!xml) continue;
    const $ = cheerio.load(xml, { xmlMode: true });
    $("w\\:t, t").each((_, element) => {
      if (accumulator.full()) return false;
      accumulator.append($(element).text());
      return true;
    });
    if (accumulator.full()) break;
  }
  return accumulator.text();
}

async function textFromXlsxFile(originalPath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(originalPath);
  const accumulator = classificationCore.createClassificationAccumulator();
  for (const sheet of workbook.worksheets || []) {
    accumulator.append(sheet.name);
    for (let rowNo = 1; rowNo <= sheet.rowCount; rowNo += 1) {
      const row = sheet.getRow(rowNo);
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      const text = values
        .map((value) => {
          if (value == null) return "";
          if (typeof value === "object") {
            if (value.text) return value.text;
            if (value.result != null) return value.result;
            if (value.richText)
              return value.richText.map((part) => part.text || "").join("");
          }
          return String(value);
        })
        .filter(Boolean)
        .join(" | ");
      accumulator.append(text);
      if (accumulator.full()) break;
    }
    if (accumulator.full()) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return accumulator.text();
}

async function textFromPdfFile(originalPath) {
  const pdfjs = optionalRequire("pdfjs-dist/legacy/build/pdf");
  if (!pdfjs?.getDocument)
    return await textFromPdfFileWithPdfParse(originalPath);
  const options = {
    data: new Uint8Array(fs.readFileSync(originalPath)),
  };
  const cMapPath = path.resolve(__dirname, "../../frontend/public/pdfjs/cmaps");
  const standardFontPath = path.resolve(
    __dirname,
    "../../frontend/public/pdfjs/standard_fonts"
  );
  if (fs.existsSync(cMapPath)) {
    options.cMapUrl = `${cMapPath}${path.sep}`;
    options.cMapPacked = true;
  }
  if (fs.existsSync(standardFontPath))
    options.standardFontDataUrl = `${standardFontPath}${path.sep}`;

  const loadingTask = pdfjs.getDocument(options);
  const pdfDocument = await loadingTask.promise;
  const accumulator = classificationCore.createClassificationAccumulator();
  try {
    for (let pageNo = 1; pageNo <= pdfDocument.numPages; pageNo += 1) {
      const page = await pdfDocument.getPage(pageNo);
      const content = await page.getTextContent();
      accumulator.append(content.items.map((item) => item.str || "").join(" "));
      page.cleanup?.();
      if (accumulator.full()) break;
      if (pageNo % 4 === 0)
        await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    await pdfDocument.destroy?.();
  }
  return accumulator.text();
}

async function textFromPdfFileWithPdfParse(originalPath) {
  const pdfParse = optionalRequire("pdf-parse");
  if (typeof pdfParse !== "function") return "";
  const data = await pdfParse(fs.readFileSync(originalPath), { max: 80 });
  return classificationCore
    .compactClassificationText(data?.text || "")
    .slice(0, READER_POSTPROCESS_TEXT_LIMIT);
}

async function textFromEpubFile(originalPath) {
  const zip = new AdmZip(originalPath);
  const pkg = formatReaders.readEpubPackage(zip);
  if (!pkg) return "";
  const accumulator = classificationCore.createClassificationAccumulator();
  for (const section of pkg.spine) {
    if (section.linear === "no" || !section.item) continue;
    if (!/html|xhtml|xml/i.test(section.item.mediaType)) continue;
    const html = formatReaders.zipEntryText(zip, section.item.path);
    if (!html) continue;
    const $ = cheerio.load(html);
    $("script, style, nav").remove();
    accumulator.append($("body").text() || $.text());
    if (accumulator.full()) break;
    if (accumulator.parts.length % 4 === 0)
      await new Promise((resolve) => setImmediate(resolve));
  }
  return accumulator.text();
}

async function extractReaderClassificationText({ documentType, originalPath }) {
  if (!originalPath || !validNonEmptyFile(originalPath)) return "";
  if (documentType === "markdown")
    return await textFromMarkdownFile(originalPath);
  if (documentType === "docx") return await textFromDocxFile(originalPath);
  if (documentType === "xlsx") return await textFromXlsxFile(originalPath);
  if (documentType === "pdf") return await textFromPdfFile(originalPath);
  if (documentType === "epub") return await textFromEpubFile(originalPath);
  return "";
}

function confidenceBucket(value) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return null;
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.5) return "medium";
  if (confidence > 0) return "low";
  return "none";
}

function readerClassificationLog(message, data = {}) {
  console.log("[ReaderDocumentClassification]", message, {
    titleHash: data.title ? hashLogValue(data.title) : null,
    documentType: data.documentType,
    sampleCount: data.sampleCount,
    sampleChars: data.sampleChars,
    categoryCount: data.categoryCount,
    categoryId: data.categoryId,
    confidence: confidenceBucket(data.confidence),
    durationMs: data.durationMs,
    responseChars: data.responseChars,
  });
}

function withClassificationTimeout(promise) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("classification_timeout");
      error.code = "CLASSIFICATION_TIMEOUT";
      reject(error);
    }, CLASSIFICATION_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function classifyReaderDocumentWithDeepSeek(body = {}) {
  const categories = classificationCore.sanitizedClassificationCategories(
    body.categories
  );
  if (!categories.length)
    return classificationCore.classificationFallback({
      title: body.title,
      categories,
      reason: classificationCore.safeClassificationReason("empty_categories"),
    });
  const samples = classificationCore.cappedClassificationSamples(body.samples);
  const sampleStrategy =
    String(body.sampleStrategy || "").slice(0, 80) +
    (classificationCore.classificationSampleCharCount(body.samples) >
    CLASSIFICATION_LLM_TEXT_LIMIT
      ? "-server-llm-cap-3000"
      : "");
  const sampleChars = classificationCore.classificationSampleCharCount(samples);
  if (!samples.length)
    return classificationCore.classificationFallback({
      title: body.title,
      categories,
      reason: classificationCore.safeClassificationReason("failed"),
      sampleStrategy,
    });

  const taskProvider = resolveTaskProviderModel(
    "reader_document_classification"
  );
  if (taskProvider.provider === "deepseek" && !process.env.DEEPSEEK_API_KEY)
    return classificationCore.classificationFallback({
      title: body.title,
      categories,
      reason: classificationCore.safeClassificationReason("missing_key"),
      sampleStrategy,
    });

  try {
    readerClassificationLog("start", {
      title: String(body.title || "").slice(0, 80),
      documentType: body.documentType,
      sampleCount: samples.length,
      sampleChars,
      categoryCount: categories.length,
    });
    const { connector: LLMConnector, provider } = getTaskConnector(
      "reader_document_classification"
    );
    if (
      typeof LLMConnector?.compressMessages !== "function" ||
      typeof LLMConnector?.getChatCompletion !== "function"
    ) {
      const error = new Error("classification_connector_unavailable");
      error.code =
        provider === "deepseek"
          ? "LLM_TASK_PROVIDER_MISSING_KEY"
          : "LLM_TASK_CONNECTOR_UNAVAILABLE";
      throw error;
    }
    const prompt = classificationCore.buildReaderClassificationPrompt({
      title: body.title,
      documentType: body.documentType,
      categories,
      samples,
      sampleStrategy,
      totalChars: Number(body.totalChars) || 0,
    });
    const messages = await LLMConnector.compressMessages(
      {
        systemPrompt:
          "你是书籍分类器。你必须只输出严格 JSON，并且只能从给定分类中选择。",
        userPrompt: prompt,
        contextTexts: [],
        chatHistory: [],
        attachments: [],
      },
      []
    );
    const llmStartedAt = Date.now();
    const { textResponse, metrics } = await withClassificationTimeout(
      LLMConnector.getChatCompletion(messages, {
        temperature: 0.1,
        responseFormat: { type: "json_object" },
      })
    );
    readerClassificationLog("llm_returned", {
      title: String(body.title || "").slice(0, 80),
      durationMs:
        Math.round(Number(metrics?.duration || 0) * 1000) ||
        Date.now() - llmStartedAt,
      responseChars: String(textResponse || "").length,
    });
    let parsed = null;
    try {
      parsed = classificationCore.parseClassificationJson(textResponse);
    } catch {
      const fallback = classificationCore.classificationFallback({
        title: body.title,
        categories,
        reason: classificationCore.safeClassificationReason("invalid_json"),
        sampleStrategy,
      });
      readerClassificationLog("fallback", {
        title: String(body.title || "").slice(0, 80),
        reason: fallback.reason,
      });
      return fallback;
    }
    const result = classificationCore.validateClassificationResult({
      result: parsed,
      categories,
      sampleStrategy,
      title: body.title,
    });
    readerClassificationLog(
      result.categoryStatus === "classified" ? "classified" : "fallback",
      {
        title: String(body.title || "").slice(0, 80),
        categoryId: result.category?.primaryCategoryId,
        confidence: result.category?.confidence,
        reason: result.reason || result.categoryReason || "",
      }
    );
    return result;
  } catch (error) {
    const type =
      error?.code === "CLASSIFICATION_TIMEOUT"
        ? "timeout"
        : error?.code === "LLM_TASK_PROVIDER_MISSING_KEY"
          ? "missing_key"
          : "unavailable";
    const fallback = classificationCore.classificationFallback({
      title: body.title,
      categories,
      reason: classificationCore.safeClassificationReason(type),
      sampleStrategy,
    });
    readerClassificationLog("fallback", {
      title: String(body.title || "").slice(0, 80),
      reason: fallback.reason,
    });
    return fallback;
  }
}

module.exports = {
  ...classificationCore,
  classifyReaderDocumentWithDeepSeek,
  extractReaderClassificationText,
  optionalRequire,
  textFromDocxFile,
  textFromEpubFile,
  textFromMarkdownFile,
  textFromPdfFile,
  textFromPdfFileWithPdfParse,
  textFromXlsxFile,
};
