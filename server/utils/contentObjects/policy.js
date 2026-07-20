const crypto = require("crypto");

const MIB = 1024 * 1024;
const DEFAULTS = Object.freeze({
  maxFileBytes: 25 * MIB,
  maxTurnBytes: 50 * MIB,
  maxFilesPerTurn: 10,
  maxAssistantTextBytes: 2 * MIB,
  assistantTextPreviewBytes: 64 * 1024,
  chunkBytes: 4 * MIB,
  uploadPartBytes: 8 * MIB,
  uploadTtlMs: 24 * 60 * 60 * 1000,
});

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function contentObjectLimits(env = process.env) {
  return {
    maxFileBytes: positiveInteger(
      env.ATHENA_CHAT_ATTACHMENT_MAX_BYTES,
      DEFAULTS.maxFileBytes
    ),
    maxTurnBytes: positiveInteger(
      env.ATHENA_CHAT_ATTACHMENT_TURN_MAX_BYTES,
      DEFAULTS.maxTurnBytes
    ),
    maxFilesPerTurn: positiveInteger(
      env.ATHENA_CHAT_ATTACHMENT_MAX_FILES,
      DEFAULTS.maxFilesPerTurn
    ),
    maxAssistantTextBytes: positiveInteger(
      env.ATHENA_CHAT_TEXT_MAX_BYTES,
      DEFAULTS.maxAssistantTextBytes
    ),
    assistantTextPreviewBytes: positiveInteger(
      env.ATHENA_CHAT_TEXT_PREVIEW_BYTES,
      DEFAULTS.assistantTextPreviewBytes
    ),
    chunkBytes: positiveInteger(
      env.ATHENA_CONTENT_OBJECT_CHUNK_BYTES,
      DEFAULTS.chunkBytes
    ),
    uploadPartBytes: positiveInteger(
      env.ATHENA_CHAT_UPLOAD_PART_BYTES,
      DEFAULTS.uploadPartBytes
    ),
    uploadTtlMs: positiveInteger(
      env.ATHENA_CHAT_UPLOAD_TTL_MS,
      DEFAULTS.uploadTtlMs
    ),
  };
}

function contentObjectMode(env = process.env) {
  const fallback = env.NODE_ENV === "development" ? "write" : "off";
  const mode = String(env.ATHENA_CHAT_CONTENT_OBJECTS || fallback)
    .trim()
    .toLowerCase();
  return ["off", "shadow", "write", "read"].includes(mode) ? mode : "off";
}

function contentObjectWritesEnabled(env = process.env) {
  return ["shadow", "write", "read"].includes(contentObjectMode(env));
}

function referencePayloadEnabled(env = process.env) {
  return ["write", "read"].includes(contentObjectMode(env));
}

function contentStoreProvider(env = process.env) {
  const provider = String(env.ATHENA_CONTENT_STORE || "local")
    .trim()
    .toLowerCase();
  return provider === "s3" ? "s3" : "local";
}

function contentObjectError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

function decodeAttachmentContent(contentString = "") {
  const value = String(contentString || "");
  const match = value.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s);
  const encoded = match ? match[2] : value;
  if (!encoded || !/^[A-Za-z0-9+/=_\r\n-]+$/.test(encoded)) {
    throw contentObjectError("chat_attachment_invalid_base64");
  }
  try {
    return {
      buffer: Buffer.from(encoded, "base64"),
      dataUrlMime: match?.[1] || null,
      wasDataUrl: Boolean(match),
    };
  } catch {
    throw contentObjectError("chat_attachment_invalid_base64");
  }
}

function validateAttachmentBatch(
  attachments = [],
  limits = contentObjectLimits()
) {
  if (!Array.isArray(attachments))
    throw contentObjectError("chat_attachments_invalid");
  if (attachments.length > limits.maxFilesPerTurn) {
    throw contentObjectError("chat_attachment_count_exceeded", {
      maxFiles: limits.maxFilesPerTurn,
    });
  }
  let totalBytes = 0;
  const decoded = attachments.map((attachment) => {
    if (!attachment?.contentString) return { attachment, decoded: null };
    const value = decodeAttachmentContent(attachment.contentString);
    if (value.buffer.length > limits.maxFileBytes) {
      throw contentObjectError("chat_attachment_too_large", {
        maxBytes: limits.maxFileBytes,
      });
    }
    totalBytes += value.buffer.length;
    return { attachment, decoded: value };
  });
  if (totalBytes > limits.maxTurnBytes) {
    throw contentObjectError("chat_attachment_turn_too_large", {
      maxBytes: limits.maxTurnBytes,
    });
  }
  return { decoded, totalBytes };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

module.exports = {
  DEFAULTS,
  contentObjectError,
  contentObjectLimits,
  contentObjectMode,
  contentObjectWritesEnabled,
  contentStoreProvider,
  decodeAttachmentContent,
  referencePayloadEnabled,
  sha256,
  validateAttachmentBatch,
};
