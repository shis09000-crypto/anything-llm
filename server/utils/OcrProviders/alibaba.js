const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen-vl-ocr-latest";
const ALLOWED_IMAGE_DATA_URL_PATTERN =
  /^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=]+$/i;

function assertImageDataUrl(imageDataUrl) {
  const value = String(imageDataUrl || "").trim();
  if (!ALLOWED_IMAGE_DATA_URL_PATTERN.test(value))
    throw new Error("OCR image must be a PNG or JPEG data URL.");
  return value;
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

async function recognizeImage({
  imageDataUrl,
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  model = DEFAULT_MODEL,
  fetchImpl = fetch,
}) {
  const imageUrl = assertImageDataUrl(imageDataUrl);
  const cleanBaseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const response = await fetchImpl(`${cleanBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "请识别图片中的文字，只返回识别出的原文文本，不要解释。",
            },
            {
              type: "image_url",
              image_url: { url: imageUrl },
            },
          ],
        },
      ],
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      payload?.error?.message ||
        payload?.message ||
        "OCR provider request failed."
    );
  }

  return {
    text: extractTextFromCompletion(payload),
    raw: payload,
  };
}

module.exports = {
  assertImageDataUrl,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  extractTextFromCompletion,
  recognizeImage,
};
