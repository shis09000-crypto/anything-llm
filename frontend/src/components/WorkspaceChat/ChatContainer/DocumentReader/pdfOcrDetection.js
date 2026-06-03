const MAX_PDF_TEXT_DETECTION_PAGES = 10;
const MIN_TOTAL_TEXT_LENGTH = 300;
const MIN_AVERAGE_TEXT_LENGTH_PER_PAGE = 80;
const MIN_MEANINGFUL_CHAR_RATIO = 0.35;
const MAX_JUNK_CHAR_RATIO = 0.25;

function compactPdfText(text = "") {
  return String(text || "")
    .replaceAll(String.fromCharCode(0), "")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sampledPdfPageNumbers(pageCount = 0, maxPages = 10) {
  const count = Math.max(0, Number(pageCount) || 0);
  const limit = Math.max(1, Math.min(maxPages, MAX_PDF_TEXT_DETECTION_PAGES));
  if (!count) return [];
  if (count <= limit)
    return Array.from({ length: count }, (_, index) => index + 1);

  const pages = new Set();
  for (let index = 0; index < limit; index += 1) {
    pages.add(Math.round(1 + (index * (count - 1)) / (limit - 1)));
  }
  return [...pages].sort((a, b) => a - b);
}

function textQuality(text = "") {
  const normalized = compactPdfText(text);
  const chars = [...normalized];
  if (!chars.length)
    return {
      extractedTextLength: 0,
      meaningfulCharRatio: 0,
      junkCharRatio: 0,
      repetitiveShortText: false,
    };

  const meaningfulChars = chars.filter((char) =>
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Latin}\p{Number}]/u.test(
      char
    )
  ).length;
  const junkChars = chars.filter((char) => {
    const code = char.charCodeAt(0);
    return (
      code <= 31 ||
      (code >= 127 && code <= 159) ||
      (code >= 0xe000 && code <= 0xf8ff) ||
      code === 0xfffd
    );
  }).length;
  const tokens = normalized.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Latin}\p{Number}]+/gu
  );
  const meaningfulTokens = (tokens || []).filter((token) => token.length > 1);
  const uniqueTokens = new Set(meaningfulTokens.map((token) => token.trim()));
  const repetitiveShortText =
    meaningfulTokens.length >= 8 && uniqueTokens.size <= 3;

  return {
    extractedTextLength: normalized.length,
    meaningfulCharRatio: meaningfulChars / chars.length,
    junkCharRatio: junkChars / chars.length,
    repetitiveShortText,
  };
}

export function classifyPdfTextDetection({
  pageCount = 0,
  text = "",
  extractionFailed = false,
}) {
  const effectivePageCount = Math.max(1, Number(pageCount) || 1);
  const quality = textQuality(text);
  const averageTextLengthPerPage =
    quality.extractedTextLength / effectivePageCount;

  if (extractionFailed) return { isLikelyScannedPdf: true, reason: "failed" };
  if (!quality.extractedTextLength)
    return { isLikelyScannedPdf: true, reason: "empty_text" };
  if (quality.extractedTextLength < MIN_TOTAL_TEXT_LENGTH)
    return { isLikelyScannedPdf: true, reason: "too_little_text" };
  if (averageTextLengthPerPage < MIN_AVERAGE_TEXT_LENGTH_PER_PAGE)
    return { isLikelyScannedPdf: true, reason: "low_average_text_per_page" };
  if (quality.junkCharRatio > MAX_JUNK_CHAR_RATIO)
    return { isLikelyScannedPdf: true, reason: "junk_text" };
  if (quality.meaningfulCharRatio < MIN_MEANINGFUL_CHAR_RATIO)
    return { isLikelyScannedPdf: true, reason: "low_meaningful_text_ratio" };
  if (quality.repetitiveShortText)
    return { isLikelyScannedPdf: true, reason: "repetitive_short_text" };

  return { isLikelyScannedPdf: false, reason: "text_layer_ok" };
}

export async function detectPdfTextLayer({
  pdfDocument,
  documentId = null,
  pdfFingerprint = null,
  maxPages = MAX_PDF_TEXT_DETECTION_PAGES,
} = {}) {
  const pageCount = Number(pdfDocument?.numPages || 0);
  if (!pdfDocument || !pageCount) {
    return {
      documentId,
      pdfFingerprint,
      isPdf: false,
      pageCount: 0,
      hasTextLayer: false,
      extractedTextLength: 0,
      averageTextLengthPerPage: 0,
      isLikelyScannedPdf: false,
      reason: "not_pdf",
    };
  }

  const sampledPages = sampledPdfPageNumbers(pageCount, maxPages);
  const parts = [];
  let extractionFailed = false;

  for (const pageNo of sampledPages) {
    try {
      const page = await pdfDocument.getPage(pageNo);
      const content = await page.getTextContent();
      parts.push((content.items || []).map((item) => item.str || "").join(" "));
      page.cleanup?.();
    } catch {
      extractionFailed = true;
      break;
    }
  }

  const text = compactPdfText(parts.join("\n"));
  const classification = classifyPdfTextDetection({
    pageCount: sampledPages.length || pageCount,
    text,
    extractionFailed,
  });
  const extractedTextLength = text.length;
  const averageTextLengthPerPage =
    extractedTextLength / Math.max(1, sampledPages.length || pageCount);

  return {
    documentId,
    pdfFingerprint,
    isPdf: true,
    pageCount,
    sampledPages,
    hasTextLayer: !extractionFailed && extractedTextLength > 0,
    extractedTextLength,
    averageTextLengthPerPage,
    isLikelyScannedPdf: classification.isLikelyScannedPdf,
    reason: classification.reason,
  };
}
