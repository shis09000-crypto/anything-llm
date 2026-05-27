const crypto = require("crypto");

const ALLOWED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_EDGE = 2400;
const WEBP_QUALITY = 82;
const VISUAL_METADATA_KEYS = [
  "dominantColor",
  "averageColor",
  "brightness",
  "contrastHint",
  "temperatureHint",
  "themeHint",
];

function readUInt24LE(buffer, offset) {
  return (
    buffer[offset] + (buffer[offset + 1] << 8) + (buffer[offset + 2] << 16)
  );
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
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8)
    return null;
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

function channelToHex(value) {
  return Math.max(0, Math.min(255, Math.round(value || 0)))
    .toString(16)
    .padStart(2, "0");
}

function rgbToHex([red, green, blue] = []) {
  return `#${channelToHex(red)}${channelToHex(green)}${channelToHex(blue)}`;
}

function fallbackVisualMetadata({ scopeType = "workspace" } = {}) {
  const color = scopeType === "node" ? "#e0f2fe" : "#dbeafe";
  return {
    dominantColor: color,
    averageColor: color,
    brightness: 0.86,
    contrastHint: "light",
    temperatureHint: "cool",
    themeHint: "light-cool",
  };
}

function dominantColorFromStats(stats, fallback) {
  const channels = stats?.channels || [];
  if (channels.length < 3) return fallback;
  return `#${channelToHex(channels[0].mean)}${channelToHex(
    channels[1].mean
  )}${channelToHex(channels[2].mean)}`;
}

function relativeLuminance([red = 0, green = 0, blue = 0] = []) {
  const channels = [red, green, blue].map((value) => {
    const normalized = Math.max(0, Math.min(255, value)) / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function classifyBrightness(brightness, spread = 0) {
  if (spread > 0.28 && brightness > 0.32 && brightness < 0.78) return "mixed";
  if (brightness < 0.45) return "dark";
  if (brightness > 0.7) return "light";
  return "mixed";
}

function classifyTemperature([red = 0, green = 0, blue = 0] = []) {
  const warmth = red - blue + (green - blue) * 0.18;
  if (warmth > 18) return "warm";
  if (warmth < -14) return "cool";
  return "neutral";
}

function themeHintFor({ contrastHint, temperatureHint }) {
  return `${contrastHint || "light"}-${temperatureHint || "neutral"}`;
}

function dominantColorFromPixels(data, fallback) {
  if (!data?.length) return fallback;
  const buckets = new Map();
  for (let offset = 0; offset < data.length; offset += 3) {
    const red = data[offset] >> 4;
    const green = data[offset + 1] >> 4;
    const blue = data[offset + 2] >> 4;
    const key = `${red}:${green}:${blue}`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  let bestKey = null;
  let bestCount = 0;
  for (const [key, count] of buckets.entries()) {
    if (count > bestCount) {
      bestKey = key;
      bestCount = count;
    }
  }
  if (!bestKey) return fallback;
  return rgbToHex(bestKey.split(":").map((value) => Number(value) * 16 + 8));
}

function visualMetadataFromStats(stats, fallback) {
  const channels = stats?.channels || [];
  if (channels.length < 3) return fallback;
  const averageRgb = channels.slice(0, 3).map((channel) => channel.mean || 0);
  const averageColor = rgbToHex(averageRgb);
  const brightness = Number(relativeLuminance(averageRgb).toFixed(3));
  const spread =
    channels
      .slice(0, 3)
      .reduce((sum, channel) => sum + Number(channel.stdev || 0), 0) /
    (3 * 255);
  const contrastHint = classifyBrightness(brightness, spread);
  const temperatureHint = classifyTemperature(averageRgb);
  return {
    dominantColor: dominantColorFromStats(stats, fallback.dominantColor),
    averageColor,
    brightness,
    contrastHint,
    temperatureHint,
    themeHint: themeHintFor({ contrastHint, temperatureHint }),
  };
}

async function analyzeImageBuffer(buffer, { scopeType = "workspace" } = {}) {
  const validation = validateImageBuffer(buffer, {
    scopeType,
    allowOversizedDimensions: true,
  });
  if (!validation.valid) return validation;

  const fallback = fallbackVisualMetadata({ scopeType });
  let sharp;
  try {
    sharp = require("sharp");
  } catch {
    return {
      ...validation,
      ...fallback,
      visualAnalysisFallback: true,
    };
  }

  try {
    const image = sharp(buffer, { failOnError: true }).rotate();
    const stats = await image.clone().stats();
    const { data } = await image
      .clone()
      .resize({ width: 48, height: 48, fit: "cover" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const metadata = visualMetadataFromStats(stats, fallback);
    metadata.dominantColor = dominantColorFromPixels(
      data,
      metadata.dominantColor
    );
    return {
      ...validation,
      ...metadata,
    };
  } catch {
    return {
      ...validation,
      ...fallback,
      visualAnalysisFallback: true,
    };
  }
}

function validateImageBuffer(
  buffer,
  { scopeType = "workspace", allowOversizedDimensions = false } = {}
) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0)
    return { valid: false, error: "empty_image" };
  if (buffer.length > MAX_IMAGE_BYTES)
    return { valid: false, error: "image_too_large" };

  const parsed = parsePng(buffer) || parseJpeg(buffer) || parseWebp(buffer);
  if (!parsed || !ALLOWED_IMAGE_MIMES.has(parsed.mime))
    return { valid: false, error: "unsupported_image_type" };
  if (!parsed.width || !parsed.height)
    return { valid: false, error: "image_dimensions_unreadable" };
  if (
    Math.max(parsed.width, parsed.height) > MAX_IMAGE_EDGE &&
    !allowOversizedDimensions
  )
    return { valid: false, error: "image_dimensions_too_large" };

  return {
    valid: true,
    mime: parsed.mime,
    ext: parsed.ext,
    imageWidth: parsed.width,
    imageHeight: parsed.height,
    size: buffer.length,
    checksum: crypto.createHash("sha256").update(buffer).digest("hex"),
    ...fallbackVisualMetadata({ scopeType }),
  };
}

async function optimizeImageBuffer(buffer, { scopeType = "workspace" } = {}) {
  const validation = validateImageBuffer(buffer, {
    scopeType,
    allowOversizedDimensions: true,
  });
  if (!validation.valid) return validation;

  const fallback = fallbackVisualMetadata({ scopeType });
  let sharp;
  try {
    sharp = require("sharp");
  } catch {
    if (
      Math.max(validation.imageWidth, validation.imageHeight) > MAX_IMAGE_EDGE
    )
      return { valid: false, error: "image_dimensions_too_large" };
    return {
      ...validation,
      ...fallback,
      buffer,
      ext: validation.ext,
      optimized: false,
      visualAnalysisFallback: true,
    };
  }

  try {
    const pipeline = sharp(buffer, { failOnError: true }).rotate().resize({
      width: MAX_IMAGE_EDGE,
      height: MAX_IMAGE_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    });
    const stats = await pipeline.clone().stats();
    const { data: sampleData } = await pipeline
      .clone()
      .resize({ width: 48, height: 48, fit: "cover" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { data, info } = await pipeline
      .webp({ quality: WEBP_QUALITY, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    if (data.length > MAX_IMAGE_BYTES)
      return { valid: false, error: "image_too_large" };

    const visualMetadata = visualMetadataFromStats(stats, fallback);
    visualMetadata.dominantColor = dominantColorFromPixels(
      sampleData,
      visualMetadata.dominantColor
    );

    return {
      valid: true,
      mime: "image/webp",
      ext: ".webp",
      imageWidth: info.width,
      imageHeight: info.height,
      size: data.length,
      checksum: crypto.createHash("sha256").update(data).digest("hex"),
      ...visualMetadata,
      buffer: data,
      optimized: true,
      originalMime: validation.mime,
      originalWidth: validation.imageWidth,
      originalHeight: validation.imageHeight,
      originalSize: validation.size,
    };
  } catch {
    return { valid: false, error: "invalid_image_upload" };
  }
}

module.exports = {
  ALLOWED_IMAGE_MIMES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
  VISUAL_METADATA_KEYS,
  analyzeImageBuffer,
  fallbackVisualMetadata,
  optimizeImageBuffer,
  validateImageBuffer,
};
