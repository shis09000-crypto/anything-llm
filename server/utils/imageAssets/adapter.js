const crypto = require("crypto");
const path = require("path");
const sharp = require("sharp");
const { DataAccessCenter } = require("../dataAccess");

const PROVIDER = "deepseek";
const ADAPTATION_VERSION = "deepseek-image-v1";
const PROVIDER_DERIVATIVE_DOMAIN = "provider-image-derivative";
const MAX_IMAGE_EDGE = 8_192;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const FILE_TTL_SECONDS = 30 * 24 * 60 * 60;
const RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1_000;
const SUPPORTED_FORMATS = new Map([
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
]);
const uploadFlights = new Map();

/**
 * @typedef {Object} PersistentImageInputRef
 * @property {"persistent"} kind
 * @property {string} assetId
 * @property {string=} attachmentRefId
 * @property {string} name
 * @property {string} mimeType
 * @property {number} byteSize
 * @property {string} sha256
 * @property {"original"} detail
 *
 * @typedef {Object} EphemeralImageInputRef
 * @property {"ephemeral"} kind
 * @property {"computer_use"|"browser_capture"|"runtime_capture"|"codex"} source
 * @property {string} dataUrl
 * @property {string} mimeType
 * @property {string} sha256
 * @property {string} capturedAt
 * @property {"original"} detail
 * @property {"turn"} retention
 *
 * @typedef {Object} RemoteImageInputRef
 * @property {"remote"} kind
 * @property {string} url
 * @property {string=} mimeType
 * @property {"original"} detail
 *
 * @typedef {PersistentImageInputRef|EphemeralImageInputRef|RemoteImageInputRef} ImageInputRef
 */

function imageAssetError(code, cause = null, httpStatus = 400) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = httpStatus;
  if (cause) error.cause = cause;
  return error;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function decodeDataUrl(value = "") {
  const match = String(value).match(
    /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i
  );
  if (!match) throw imageAssetError("responses_image_data_invalid");
  const encoded = match[2].replace(/\s+/g, "");
  const buffer = Buffer.from(encoded, "base64");
  if (
    !buffer.length ||
    buffer.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
  )
    throw imageAssetError("responses_image_data_invalid");
  if (buffer.length > MAX_FILE_BYTES)
    throw imageAssetError("responses_image_too_large");
  const mimeType = String(match[1]).toLowerCase();
  return { mime: mimeType, mimeType, buffer };
}

function safeImageName(name = "image", mimeType = "image/jpeg") {
  const extensionByMime = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
  };
  const safe = path.basename(String(name || "image")).slice(0, 220);
  if (path.extname(safe)) return safe;
  return `${safe}${extensionByMime[mimeType] || ".jpg"}`;
}

async function compatibleImage({ buffer, name = "image" }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length)
    throw imageAssetError("responses_image_empty");
  if (buffer.length > MAX_FILE_BYTES)
    throw imageAssetError("responses_image_too_large");

  let metadata;
  try {
    metadata = await sharp(buffer, { animated: true }).metadata();
  } catch (cause) {
    throw imageAssetError("responses_image_decode_failed", cause);
  }
  const detectedMimeType = SUPPORTED_FORMATS.get(metadata.format) || null;
  const withinDimensions =
    Number(metadata.width || 0) <= MAX_IMAGE_EDGE &&
    Number(metadata.height || 0) <= MAX_IMAGE_EDGE;
  if (detectedMimeType && withinDimensions) {
    return {
      adapted: false,
      buffer,
      mime: detectedMimeType,
      mimeType: detectedMimeType,
      name: safeImageName(name, detectedMimeType),
      metadata,
    };
  }

  try {
    let pipeline = sharp(buffer, { animated: false }).rotate().resize({
      width: MAX_IMAGE_EDGE,
      height: MAX_IMAGE_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    });
    const preserveAlpha = Boolean(metadata.hasAlpha);
    pipeline = preserveAlpha
      ? pipeline.png({ compressionLevel: 9 })
      : pipeline.jpeg({ quality: 95, chromaSubsampling: "4:4:4" });
    const converted = await pipeline.toBuffer();
    if (converted.length > MAX_FILE_BYTES)
      throw imageAssetError("responses_image_too_large");
    const mimeType = preserveAlpha ? "image/png" : "image/jpeg";
    return {
      adapted: true,
      buffer: converted,
      mime: mimeType,
      mimeType,
      name: safeImageName(path.parse(String(name || "image")).name, mimeType),
      metadata: await sharp(converted).metadata(),
    };
  } catch (cause) {
    if (cause?.code === "responses_image_too_large") throw cause;
    throw imageAssetError("responses_image_conversion_failed", cause);
  }
}

function deepSeekBaseUrl(env = process.env) {
  return String(
    env.DEEPSEEK_API_BASE_URL ||
      env.DEEPSEEK_BASE_URL ||
      "https://api.deepseek.com"
  )
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "");
}

function credentialScopeHash(env = process.env) {
  const apiKey = String(env.DEEPSEEK_API_KEY || "").trim();
  if (!apiKey) throw imageAssetError("deepseek_vision_api_key_missing");
  return sha256(`${PROVIDER}\n${deepSeekBaseUrl(env)}\n${sha256(apiKey)}`);
}

function reusableBinding(binding, now = Date.now()) {
  if (!binding || binding.status !== "ready" || !binding.providerFileId)
    return false;
  if (!binding.expiresAt) return true;
  return new Date(binding.expiresAt).getTime() > now + RENEWAL_WINDOW_MS;
}

function providerExpiry(result, now = Date.now()) {
  const value = result?.expires_at || result?.expiresAt || null;
  if (value) {
    const parsed =
      typeof value === "number" ? value * 1_000 : Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  return new Date(now + FILE_TTL_SECONDS * 1_000);
}

async function uploadDeepSeekFile(
  image,
  { env = process.env, fetchImpl = globalThis.fetch } = {}
) {
  const apiKey = String(env.DEEPSEEK_API_KEY || "").trim();
  if (!apiKey) throw imageAssetError("deepseek_vision_api_key_missing");
  if (typeof fetchImpl !== "function")
    throw imageAssetError("deepseek_vision_upload_unavailable", null, 503);
  const form = new FormData();
  form.append("purpose", "user_data");
  form.append("expires_after[anchor]", "created_at");
  form.append("expires_after[seconds]", String(FILE_TTL_SECONDS));
  form.append(
    "file",
    new Blob([image.buffer], { type: image.mimeType }),
    image.name
  );
  let response;
  try {
    response = await fetchImpl(`${deepSeekBaseUrl(env)}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (cause) {
    throw imageAssetError("deepseek_vision_upload_failed", cause, 502);
  }
  if (!response?.ok) {
    const error = imageAssetError(
      "deepseek_vision_upload_failed",
      null,
      Number(response?.status || 502)
    );
    error.providerStatus = Number(response?.status || 0);
    throw error;
  }
  const result = await response.json().catch(() => null);
  const providerFileId = String(result?.id || "").trim();
  if (!providerFileId)
    throw imageAssetError("deepseek_vision_file_id_missing", null, 502);
  return { result, providerFileId };
}

async function deleteDeepSeekFile(
  providerFileId,
  { env = process.env, fetchImpl = globalThis.fetch } = {}
) {
  const apiKey = String(env.DEEPSEEK_API_KEY || "").trim();
  if (!apiKey) throw imageAssetError("deepseek_vision_api_key_missing");
  if (typeof fetchImpl !== "function")
    throw imageAssetError("deepseek_vision_delete_unavailable", null, 503);
  let response;
  try {
    response = await fetchImpl(
      `${deepSeekBaseUrl(env)}/files/${encodeURIComponent(String(providerFileId))}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${apiKey}` },
      }
    );
  } catch (cause) {
    throw imageAssetError("deepseek_vision_delete_failed", cause, 502);
  }
  if (response?.ok || Number(response?.status) === 404) return true;
  const error = imageAssetError(
    "deepseek_vision_delete_failed",
    null,
    Number(response?.status || 502)
  );
  error.providerStatus = Number(response?.status || 0);
  throw error;
}

async function resolvePersistent(
  ref,
  {
    workspaceId,
    env = process.env,
    fetchImpl = globalThis.fetch,
    dataAccess = DataAccessCenter,
    forceRefresh = false,
  } = {}
) {
  if (String(env.ATHENA_IMAGE_ASSET_ADAPTER || "enabled") === "disabled")
    throw imageAssetError("image_asset_adapter_disabled", null, 503);
  if (!workspaceId) throw imageAssetError("responses_image_workspace_missing");
  const imageAssetId = String(ref.assetId || "").trim();
  if (!imageAssetId) throw imageAssetError("responses_image_asset_missing");
  const scopeHash = credentialScopeHash(env);
  const flightKey = `${imageAssetId}:${scopeHash}:${ADAPTATION_VERSION}`;
  if (!forceRefresh && uploadFlights.has(flightKey))
    return uploadFlights.get(flightKey);

  const task = (async () => {
    const existing = await dataAccess.contentObject.providerFileBinding({
      imageAssetId,
      provider: PROVIDER,
      credentialScopeHash: scopeHash,
      adaptationVersion: ADAPTATION_VERSION,
    });
    if (!forceRefresh && reusableBinding(existing)) {
      await dataAccess.contentObject
        .touchProviderFileBinding(existing.id)
        .catch(() => null);
      return {
        type: "input_image",
        file_id: existing.providerFileId,
        bindingId: existing.id,
        assetId: imageAssetId,
      };
    }

    const logicalAsset = await dataAccess.imageAsset.getForModel({
      assetId: imageAssetId,
      workspaceId,
    });
    if (!logicalAsset?.originalContentObjectId)
      throw imageAssetError("responses_image_asset_not_found", null, 404);
    const asset = await dataAccess.contentObject.assetForWorkspace({
      assetId: logicalAsset.originalContentObjectId,
      workspaceId,
    });
    if (!asset)
      throw imageAssetError("responses_image_asset_not_found", null, 404);
    const sourceBuffer = await dataAccess.contentObject.readWhole(asset);
    const image = await compatibleImage({
      buffer: sourceBuffer,
      name: ref.name || "image",
    });
    let derivativeAssetId = null;
    if (image.adapted) {
      const derivative = await dataAccess.contentObject.stageBuffer({
        ownerType: "workspace",
        ownerId: workspaceId,
        domain: PROVIDER_DERIVATIVE_DOMAIN,
        buffer: image.buffer,
        mimeType: image.mimeType,
      });
      derivativeAssetId = derivative.id;
      await dataAccess.contentObject.retain(derivative.id, 1);
    }

    const uploaded = await uploadDeepSeekFile(image, { env, fetchImpl });
    const now = new Date();
    const binding = await dataAccess.contentObject.saveProviderFileBinding({
      assetId: asset.id,
      imageAssetId,
      derivativeAssetId,
      provider: PROVIDER,
      credentialScopeHash: scopeHash,
      adaptationVersion: ADAPTATION_VERSION,
      providerFileId: uploaded.providerFileId,
      providerMimeType: image.mimeType,
      providerByteSize: image.buffer.length,
      providerSha256: sha256(image.buffer),
      status: "ready",
      providerCreatedAt: now,
      expiresAt: providerExpiry(uploaded.result, now.getTime()),
      lastVerifiedAt: now,
      lastUsedAt: now,
    });
    if (
      existing?.providerFileId &&
      existing.providerFileId !== binding.providerFileId
    ) {
      await deleteDeepSeekFile(existing.providerFileId, {
        env,
        fetchImpl,
      }).catch(() => null);
    }
    if (
      existing?.derivativeAssetId &&
      existing.derivativeAssetId !== derivativeAssetId
    ) {
      await dataAccess.contentObject
        .release(existing.derivativeAssetId, 1)
        .catch(() => null);
    }
    return {
      type: "input_image",
      file_id: binding.providerFileId,
      bindingId: binding.id,
      assetId: imageAssetId,
    };
  })();
  uploadFlights.set(flightKey, task);
  try {
    return await task;
  } finally {
    if (uploadFlights.get(flightKey) === task) uploadFlights.delete(flightKey);
  }
}

function resolveEphemeral(ref) {
  const decoded = decodeDataUrl(ref.dataUrl);
  if (!String(decoded.mimeType).startsWith("image/"))
    throw imageAssetError("responses_image_mime_invalid");
  return {
    type: "input_image",
    image_url: ref.dataUrl,
    detail: "original",
  };
}

function resolveRemote(ref) {
  let url;
  try {
    url = new URL(String(ref.url || ""));
  } catch {
    throw imageAssetError("responses_image_url_invalid");
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw imageAssetError("responses_image_url_invalid");
  if (url.href.length > 8_192)
    throw imageAssetError("responses_image_url_too_long");
  return {
    type: "input_image",
    image_url: url.href,
    detail: "original",
  };
}

async function resolveImageInput(ref, options = {}) {
  if (!ref || typeof ref !== "object")
    throw imageAssetError("responses_image_reference_invalid");
  if (ref.kind === "persistent") return resolvePersistent(ref, options);
  if (ref.kind === "ephemeral") return resolveEphemeral(ref);
  if (ref.kind === "remote") return resolveRemote(ref);
  throw imageAssetError("responses_image_reference_invalid");
}

async function invalidateBindings(bindingIds = [], failureCode) {
  await Promise.all(
    [...new Set(bindingIds.filter(Boolean))].map((id) =>
      DataAccessCenter.contentObject
        .invalidateProviderFileBinding(id, failureCode)
        .catch(() => null)
    )
  );
}

function clearUploadFlights() {
  uploadFlights.clear();
}

module.exports = {
  ADAPTATION_VERSION,
  FILE_TTL_SECONDS,
  MAX_FILE_BYTES,
  MAX_IMAGE_EDGE,
  PROVIDER,
  clearUploadFlights,
  compatibleImage,
  credentialScopeHash,
  decodeDataUrl,
  deleteDeepSeekFile,
  deepSeekBaseUrl,
  imageAssetError,
  invalidateBindings,
  resolveImageInput,
  reusableBinding,
  safeImageName,
  uploadDeepSeekFile,
};
