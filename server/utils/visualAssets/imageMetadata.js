const crypto = require("crypto");

const ALLOWED_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_EDGE = 2400;

function readUInt24LE(buffer, offset) {
  return buffer[offset] + (buffer[offset + 1] << 8) + (buffer[offset + 2] << 16);
}

function parsePng(buffer) {
  const signature = "89504e470d0a1a0a";
  if (buffer.length < 24 || buffer.slice(0, 8).toString("hex") !== signature)
    return null;
  return {
    mime: "image/png",
    ext: ".png",
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function parseJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof && length >= 7) {
      return {
        mime: "image/jpeg",
        ext: ".jpg",
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  return null;
}

function parseWebp(buffer) {
  if (
    buffer.length < 30 ||
    buffer.slice(0, 4).toString("ascii") !== "RIFF" ||
    buffer.slice(8, 12).toString("ascii") !== "WEBP"
  )
    return null;
  const chunk = buffer.slice(12, 16).toString("ascii");
  if (chunk === "VP8X" && buffer.length >= 30) {
    return {
      mime: "image/webp",
      ext: ".webp",
      width: readUInt24LE(buffer, 24) + 1,
      height: readUInt24LE(buffer, 27) + 1,
    };
  }
  if (chunk === "VP8 " && buffer.length >= 30) {
    return {
      mime: "image/webp",
      ext: ".webp",
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && buffer.length >= 25) {
    const b0 = buffer[21];
    const b1 = buffer[22];
    const b2 = buffer[23];
    const b3 = buffer[24];
    return {
      mime: "image/webp",
      ext: ".webp",
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  return null;
}

function fallbackDominantColor({ scopeType = "workspace" } = {}) {
  return scopeType === "node" ? "#e0f2fe" : "#dbeafe";
}

function validateImageBuffer(buffer, { scopeType = "workspace" } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0)
    return { valid: false, error: "empty_image" };
  if (buffer.length > MAX_IMAGE_BYTES)
    return { valid: false, error: "image_too_large" };

  const parsed = parsePng(buffer) || parseJpeg(buffer) || parseWebp(buffer);
  if (!parsed || !ALLOWED_IMAGE_MIMES.has(parsed.mime))
    return { valid: false, error: "unsupported_image_type" };
  if (!parsed.width || !parsed.height)
    return { valid: false, error: "image_dimensions_unreadable" };
  if (Math.max(parsed.width, parsed.height) > MAX_IMAGE_EDGE)
    return { valid: false, error: "image_dimensions_too_large" };

  return {
    valid: true,
    mime: parsed.mime,
    ext: parsed.ext,
    imageWidth: parsed.width,
    imageHeight: parsed.height,
    size: buffer.length,
    checksum: crypto.createHash("sha256").update(buffer).digest("hex"),
    dominantColor: fallbackDominantColor({ scopeType }),
  };
}

module.exports = {
  ALLOWED_IMAGE_MIMES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
  validateImageBuffer,
};
