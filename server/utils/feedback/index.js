const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const { logsDirectory, runtimeSummary } = require("../desktopRuntime");

const FEEDBACK_TO_EMAIL = "shis09000@gmail.com";
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function dataUrlToAttachment(
  dataUrl = "",
  fallbackName = "feedback-image.png"
) {
  const match = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const [, mimeType, base64] = match;
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`${fallbackName} is larger than 12MB.`);
  }
  const extension = mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png";
  return {
    filename: fallbackName.includes(".")
      ? fallbackName
      : `${fallbackName}.${extension}`,
    mimeType,
    contentBase64: buffer.toString("base64"),
  };
}

function addDirectoryToZip(zip, dir, zipRoot) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const zipPath = path.join(zipRoot, entry.name);
    if (entry.isDirectory()) {
      addDirectoryToZip(zip, fullPath, zipPath);
      continue;
    }
    zip.addLocalFile(fullPath, path.dirname(zipPath));
  }
}

function logsZipAttachment() {
  const dir = logsDirectory();
  const zip = new AdmZip();
  if (fs.existsSync(dir)) addDirectoryToZip(zip, dir, "logs");
  const runtime = JSON.stringify(runtimeSummary(), null, 2);
  zip.addFile("runtime-summary.json", Buffer.from(runtime, "utf8"));
  return {
    filename: `vector-knowledge-logs-${Date.now()}.zip`,
    mimeType: "application/zip",
    contentBase64: zip.toBuffer().toString("base64"),
  };
}

async function submitFeedback({ reason = "", images = [] }) {
  const trimmedReason = String(reason || "").trim();
  if (!trimmedReason) throw new Error("feedback_reason_required");

  const scriptUrl = process.env.FEEDBACK_GMAIL_SCRIPT_URL;
  const apiKey = process.env.FEEDBACK_GMAIL_API_KEY;
  if (!scriptUrl || !apiKey)
    throw new Error("feedback_delivery_not_configured");

  const imageAttachments = images
    .slice(0, MAX_IMAGES)
    .map((image, index) =>
      dataUrlToAttachment(
        image?.contentString || image?.dataUrl || image,
        image?.name || `feedback-image-${index + 1}.png`
      )
    );

  const payload = {
    key: apiKey,
    action: "send_feedback",
    to: process.env.FEEDBACK_TO_EMAIL || FEEDBACK_TO_EMAIL,
    subject: `向量知识库用户反馈 - ${new Date().toLocaleString("zh-CN")}`,
    body: [
      "用户反馈：",
      trimmedReason,
      "",
      "Runtime：",
      JSON.stringify(runtimeSummary(), null, 2),
    ].join("\n"),
    runtime: runtimeSummary(),
    attachments: [...imageAttachments.filter(Boolean), logsZipAttachment()],
  };

  const response = await fetch(scriptUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vector-Knowledge-UA": "desktop-feedback/1.0",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`feedback_delivery_failed_${response.status}`);
  }
  const result = await response.json().catch(() => ({ success: true }));
  if (result?.status === "error" || result?.success === false)
    throw new Error(result?.error || "feedback_delivery_failed");
  return { success: true };
}

module.exports = {
  submitFeedback,
};
