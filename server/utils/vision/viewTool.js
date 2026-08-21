const sharp = require("sharp");

const DEFAULT_ALIBABA_VISION_BASE_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_ALIBABA_VISION_MODEL = "qwen3-vl-flash";
const MIN_TARGET_BYTES = 400 * 1024;
const MAX_TARGET_BYTES = 500 * 1024;
const ALLOWED_IMAGE_DATA_URL_PATTERN =
  /^data:image\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i;

function isImageAttachment(attachment = {}) {
  const mime = String(attachment?.mime || "").toLowerCase();
  const contentString = String(attachment?.contentString || "");
  return (
    mime.startsWith("image/") ||
    ALLOWED_IMAGE_DATA_URL_PATTERN.test(contentString)
  );
}

function normalizeImageDataUrl(attachment = {}) {
  const contentString = String(attachment?.contentString || "").trim();
  const existingMatch = contentString.match(ALLOWED_IMAGE_DATA_URL_PATTERN);
  if (existingMatch) {
    return {
      mime: `image/${existingMatch[1].toLowerCase()}`,
      buffer: Buffer.from(existingMatch[2], "base64"),
    };
  }

  const mime = String(attachment?.mime || "image/png").toLowerCase();
  if (!mime.startsWith("image/"))
    throw new Error(
      `Attachment ${attachment?.name || "image"} is not an image.`
    );

  return {
    mime,
    buffer: Buffer.from(contentString, "base64"),
  };
}

function imageDataUrlFromBuffer(buffer, mime = "image/jpeg") {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

async function compressImageAttachment(attachment = {}) {
  const { buffer } = normalizeImageDataUrl(attachment);
  let metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch {
    throw new Error(
      `Could not read image attachment ${attachment?.name || "image"}.`
    );
  }

  let quality = 86;
  let scale = 1;
  let best = null;
  const width = metadata.width || null;

  for (let attempt = 0; attempt < 12; attempt++) {
    const pipeline = sharp(buffer).rotate();
    if (width && scale < 1) {
      pipeline.resize({
        width: Math.max(320, Math.round(width * scale)),
        withoutEnlargement: true,
      });
    }

    const output = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
    best = output;

    if (output.length >= MIN_TARGET_BYTES && output.length <= MAX_TARGET_BYTES)
      break;
    if (output.length > MAX_TARGET_BYTES) {
      if (quality > 52) quality -= 8;
      else scale *= 0.82;
      continue;
    }

    if (quality < 92 && scale === 1) {
      quality += 4;
      continue;
    }
    break;
  }

  return {
    mime: "image/jpeg",
    contentString: imageDataUrlFromBuffer(best),
    bytes: best.length,
  };
}

function visionToolEnabled() {
  return (
    process.env.ATHENA_CHAT_IMAGE_MODE === "legacy" &&
    process.env.VISION_TOOL_ENABLED !== "false"
  );
}

function shouldUseVisionTool(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0) return false;
  if (!visionToolEnabled()) return false;
  if (process.env.VISION_PROVIDER !== "alibaba") return false;
  return attachments.some(isImageAttachment);
}

function assertVisionConfig() {
  if (!process.env.VISION_API_KEY)
    throw new Error(
      "Vision image pre-analysis is enabled, but VISION_API_KEY is not configured."
    );
  if (!process.env.VISION_MODEL_PREF)
    throw new Error(
      "Vision image pre-analysis is enabled, but VISION_MODEL_PREF is not configured."
    );
}

function extractTextFromCompletion(completion = {}) {
  const content = completion?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        return "";
      })
      .join("\n")
      .trim();
  }
  return "";
}

function buildVisionPrompt(images = []) {
  const imageIds = images.map((image) => image.id).join(", ");
  return [
    "你是系统内部图片预分析工具。请仔细分析用户本次消息中的所有图片。",
    "必须按图片 ID 分段输出，不要混淆图片。",
    `图片 ID 列表：${imageIds}`,
    "每个图片 ID 下请给出：主要内容、可见文字、关键对象/人物/表格/图表、与用户文本任务可能相关的细节。",
    "如果某张图片无法识别，请在对应 ID 下明确说明无法识别。",
    "只输出图片分析结果，不要回答用户最终问题。",
  ].join("\n");
}

async function callAlibabaVision({ images, fetchImpl = fetch }) {
  const cleanBaseUrl = String(
    process.env.VISION_BASE_URL || DEFAULT_ALIBABA_VISION_BASE_URL
  ).replace(/\/+$/, "");
  const content = [{ type: "text", text: buildVisionPrompt(images) }];

  images.forEach((image) => {
    content.push({
      type: "text",
      text: `${image.id}: ${image.name || "image"} (${Math.round(
        image.bytes / 1024
      )}KB)`,
    });
    content.push({
      type: "image_url",
      image_url: { url: image.contentString },
    });
  });

  const response = await fetchImpl(`${cleanBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.VISION_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.VISION_MODEL_PREF || DEFAULT_ALIBABA_VISION_MODEL,
      messages: [{ role: "user", content }],
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      payload?.error?.message ||
        payload?.message ||
        "Vision provider request failed."
    );
  }

  const text = extractTextFromCompletion(payload);
  if (!text)
    throw new Error("Vision provider returned an empty image analysis result.");

  return text;
}

async function prepareImageAnalysisContext({
  attachments = [],
  fetchImpl = fetch,
} = {}) {
  if (!Array.isArray(attachments) || attachments.length === 0)
    return { contextText: null, llmAttachments: attachments, used: false };
  if (!shouldUseVisionTool(attachments))
    return { contextText: null, llmAttachments: attachments, used: false };

  assertVisionConfig();

  const imageAttachments = attachments.filter(isImageAttachment);
  const nonImageAttachments = attachments.filter(
    (attachment) => !isImageAttachment(attachment)
  );

  let compressedImages = [];
  try {
    compressedImages = await Promise.all(
      imageAttachments.map(async (attachment, index) => {
        const compressed = await compressImageAttachment(attachment);
        return {
          id: `image_${index + 1}`,
          name: attachment?.name || `image-${index + 1}`,
          ...compressed,
        };
      })
    );

    const analysis = await callAlibabaVision({
      images: compressedImages,
      fetchImpl,
    });

    return {
      contextText: [
        "[System image pre-analysis]",
        "The user attached image(s). Use this analysis as the authoritative visual context for the current user request. Do not assume access to the original image pixels unless they are explicitly provided elsewhere.",
        analysis,
      ].join("\n\n"),
      analysisText: analysis,
      llmAttachments: nonImageAttachments,
      used: true,
    };
  } finally {
    compressedImages.forEach((image) => {
      image.contentString = null;
    });
    compressedImages.length = 0;
  }
}

module.exports = {
  DEFAULT_ALIBABA_VISION_BASE_URL,
  DEFAULT_ALIBABA_VISION_MODEL,
  MIN_TARGET_BYTES,
  MAX_TARGET_BYTES,
  buildVisionPrompt,
  callAlibabaVision,
  compressImageAttachment,
  extractTextFromCompletion,
  isImageAttachment,
  prepareImageAnalysisContext,
  shouldUseVisionTool,
};
