import ReaderDocument from "@/models/readerDocument";
import {
  fallbackReaderCategory,
  normalizeReaderCategoryPatch,
  readReaderBookshelfCategories,
} from "./storage";

const PDFJS_PUBLIC_BASE = `${import.meta.env.BASE_URL || "/"}`.replace(
  /\/?$/,
  "/"
);
const PDFJS_ASSET_BASE = `${PDFJS_PUBLIC_BASE}pdfjs/`;
export const CLASSIFICATION_TEXT_LIMIT = 100_000;
export const CLASSIFICATION_LLM_TEXT_LIMIT = 3_000;

function compactText(text = "") {
  return String(text || "")
    .replaceAll(String.fromCharCode(0), "")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function appendWithinLimit(parts, text, limit = CLASSIFICATION_TEXT_LIMIT) {
  const next = compactText(text);
  if (!next) return 0;
  const currentLength = parts.join("\n").length;
  const remaining = limit - currentLength;
  if (remaining <= 0) return 0;
  parts.push(next.slice(0, remaining));
  return Math.min(next.length, remaining);
}

async function idleYield() {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function textFromMarkdown(file) {
  return compactText((await file.text()).slice(0, CLASSIFICATION_TEXT_LIMIT));
}

async function textFromDocx(file) {
  const mammoth = await import("mammoth/mammoth.browser");
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return compactText((result.value || "").slice(0, CLASSIFICATION_TEXT_LIMIT));
}

async function textFromXlsx(file) {
  const XLSX = await import("xlsx");
  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, { type: "array" });
  const parts = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      blankrows: false,
    });
    appendWithinLimit(parts, name);
    for (const row of rows) {
      appendWithinLimit(parts, (row || []).filter(Boolean).join(" | "));
      if (parts.join("\n").length >= CLASSIFICATION_TEXT_LIMIT) break;
    }
    if (parts.join("\n").length >= CLASSIFICATION_TEXT_LIMIT) break;
    await idleYield();
  }
  return compactText(parts.join("\n"));
}

async function textFromPdf(file) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf");
  pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_ASSET_BASE}pdf.worker.min.js`;
  const loadingTask = pdfjs.getDocument({
    data: await file.arrayBuffer(),
    cMapUrl: `${PDFJS_ASSET_BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_ASSET_BASE}standard_fonts/`,
  });
  const pdfDocument = await loadingTask.promise;
  const parts = [];
  try {
    for (let pageNo = 1; pageNo <= pdfDocument.numPages; pageNo += 1) {
      const page = await pdfDocument.getPage(pageNo);
      const content = await page.getTextContent();
      appendWithinLimit(
        parts,
        content.items.map((item) => item.str || "").join(" ")
      );
      page.cleanup?.();
      if (parts.join("\n").length >= CLASSIFICATION_TEXT_LIMIT) break;
      if (pageNo % 3 === 0) await idleYield();
    }
  } finally {
    pdfDocument.destroy?.();
  }
  return compactText(parts.join("\n"));
}

async function textFromEpub(file) {
  const { default: ePub } = await import("epubjs");
  const book = ePub(await file.arrayBuffer(), {
    openAs: "binary",
    replacements: "none",
  });
  const parts = [];
  try {
    await book.ready;
    const sections = book?.spine?.spineItems || [];
    for (const section of sections) {
      if (section?.linear === "no") continue;
      let html = "";
      try {
        html = await section.render(book.load.bind(book));
      } finally {
        section.unload?.();
      }
      const document = new DOMParser().parseFromString(html || "", "text/html");
      appendWithinLimit(parts, document.body?.textContent || "");
      if (parts.join("\n").length >= CLASSIFICATION_TEXT_LIMIT) break;
      if (parts.length % 3 === 0) await idleYield();
    }
  } finally {
    book.destroy?.();
  }
  return compactText(parts.join("\n"));
}

export async function extractReaderClassificationText(file, documentType) {
  if (!file?.size) return "";
  if (documentType === "markdown") return await textFromMarkdown(file);
  if (documentType === "docx") return await textFromDocx(file);
  if (documentType === "xlsx") return await textFromXlsx(file);
  if (documentType === "pdf") return await textFromPdf(file);
  if (documentType === "epub") return await textFromEpub(file);
  return "";
}

function strategyForLength(totalChars) {
  if (totalChars < 300) return null;
  if (totalChars < 1_200)
    return { sampleCount: 2, sampleSize: 200, positions: [0.25, 0.75] };
  if (totalChars < 5_000)
    return { sampleCount: 3, sampleSize: 300, positions: [0.15, 0.5, 0.85] };
  if (totalChars < 30_000) {
    return {
      sampleCount: 4,
      sampleSize: 400,
      positions: [0.1, 0.35, 0.65, 0.9],
    };
  }
  return {
    sampleCount: 5,
    sampleSize: 500,
    positions: [0.08, 0.28, 0.5, 0.72, 0.92],
  };
}

function capSamplesForLlm(samples = []) {
  let used = 0;
  const capped = [];
  for (const sample of samples) {
    const remaining = CLASSIFICATION_LLM_TEXT_LIMIT - used;
    if (remaining <= 0) break;
    const text = String(sample.text || "").slice(0, remaining);
    used += text.length;
    capped.push({ ...sample, text });
  }
  return capped.filter((sample) => sample.text.trim());
}

export function buildClassificationSamples(text = "") {
  const normalized = compactText(text);
  const totalChars = normalized.length;
  const strategy = strategyForLength(totalChars);
  if (!strategy) {
    return {
      ok: false,
      reason: "可用于分类的文本过少。",
      totalChars,
      sampleCount: 0,
      sampleSize: 0,
      sampleStrategy: "too-short",
      samples: [],
    };
  }

  const samples = strategy.positions.map((position, index) => {
    const center = Math.floor(totalChars * position);
    const start = Math.max(0, center - Math.floor(strategy.sampleSize / 2));
    const end = Math.min(totalChars, start + strategy.sampleSize);
    return {
      index: index + 1,
      position,
      text: normalized.slice(start, end),
    };
  });
  const cappedSamples = capSamplesForLlm(samples);
  const capped =
    cappedSamples.map((sample) => sample.text).join("").length <
    samples.map((sample) => sample.text).join("").length;
  return {
    ok: true,
    totalChars,
    sampleCount: cappedSamples.length,
    sampleSize: strategy.sampleSize,
    sampleStrategy: `balanced-${strategy.sampleCount}x${strategy.sampleSize}${
      capped ? "-llm-cap-3000" : ""
    }`,
    samples: cappedSamples,
  };
}

export async function classifyReaderBook({
  workspaceSlug,
  title,
  documentType,
  file,
  task = null,
  communicationScene = "reader-visible",
}) {
  try {
    const text = await extractReaderClassificationText(file, documentType);
    const samplePayload = buildClassificationSamples(text);
    if (!samplePayload.ok) return fallbackReaderCategory(samplePayload.reason);

    const categories = readReaderBookshelfCategories().map((category) => ({
      id: category.id,
      name: category.name,
    }));
    const { response, data } = await ReaderDocument.classify(
      workspaceSlug,
      {
        title,
        documentType,
        categories,
        ...samplePayload,
      },
      {
        communicationScene,
        task: task || {
          label: "reader:classify-visible",
          kind: "reader",
          priority: "P0",
          policy: "foreground",
          emergency: true,
          intentRank: 0,
          scope: {
            route: "workspace-chat",
            surface: "reader-classification",
            workspaceSlug,
          },
        },
      }
    );
    if (!response.ok || !data?.success) {
      return fallbackReaderCategory(data?.reason || "自动分类请求失败。");
    }
    return normalizeReaderCategoryPatch(data);
  } catch {
    return fallbackReaderCategory("自动分类失败。");
  }
}
