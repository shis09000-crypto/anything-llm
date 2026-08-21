const path = require("path");
const sharp = require("sharp");
const { DataAccessCenter } = require("../dataAccess");
const { deleteDeepSeekFile, resolveImageInput } = require("./adapter");

const PREVIEW_DOMAIN = "image-preview";
const PREVIEW_MAX_EDGE = 768;
const PREVIEW_QUALITY = 82;

function imageAssetOwner({ userId = null, workspaceId }) {
  return {
    ownerUserId: userId == null ? null : Number(userId),
    ownerScope:
      userId == null
        ? `workspace:${Number(workspaceId)}:single-user`
        : `user:${Number(userId)}`,
  };
}

function imageAssetPreviewUrl(assetId) {
  return `/api/image-assets/${encodeURIComponent(String(assetId))}/preview`;
}

function publicAsset(asset) {
  if (!asset) return null;
  const {
    originalContentObjectId: _originalContentObjectId,
    previewContentObjectId: _previewContentObjectId,
    ownerScope: _ownerScope,
    _created,
    _sourceBuffer,
    ...safe
  } = asset;
  return {
    ...safe,
    previewUrl:
      asset.status === "deleted" ? null : imageAssetPreviewUrl(asset.id),
  };
}

async function makePreview(buffer) {
  const output = await sharp(buffer, { animated: false })
    .rotate()
    .resize({
      width: PREVIEW_MAX_EDGE,
      height: PREVIEW_MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: PREVIEW_QUALITY, effort: 4 })
    .toBuffer({ resolveWithObject: true });
  return {
    buffer: output.data,
    width: Number(output.info.width || 0),
    height: Number(output.info.height || 0),
  };
}

async function ensurePreviewForAsset({ asset, buffer, workspaceId }) {
  if (asset.previewContentObjectId) return asset;
  const preview = await makePreview(buffer);
  const previewObject = await DataAccessCenter.contentObject.stageBuffer({
    ownerType: "workspace",
    ownerId: workspaceId,
    domain: PREVIEW_DOMAIN,
    buffer: preview.buffer,
    mimeType: "image/webp",
  });
  await DataAccessCenter.contentObject.retain(previewObject.id, 1);
  return DataAccessCenter.imageAsset.setPreview(asset.id, {
    previewContentObjectId: previewObject.id,
    width: preview.width,
    height: preview.height,
  });
}

async function ensureImageAssetForObject({
  workspaceId,
  userId = null,
  object,
  displayName = "image",
  sourceSummary = null,
  withPreview = true,
}) {
  if (!object || !String(object.mimeType || "").startsWith("image/"))
    return null;
  const buffer = await DataAccessCenter.contentObject.readWhole(object);
  let metadata;
  try {
    metadata = await sharp(buffer, { animated: true }).metadata();
  } catch (cause) {
    const error = new Error("image_asset_decode_failed");
    error.code = "image_asset_decode_failed";
    error.cause = cause;
    throw error;
  }
  const owner = imageAssetOwner({ userId, workspaceId });
  let asset = await DataAccessCenter.imageAsset.ensure({
    ...owner,
    workspaceId,
    originalContentObjectId: object.id,
    displayName,
    mimeType: object.mimeType,
    byteSize: object.plaintextSize,
    width: metadata.width,
    height: metadata.height,
    animated: Number(metadata.pages || 1) > 1,
    summary:
      sourceSummary || `用户上传图片：${path.basename(String(displayName))}`,
  });
  if (asset?._created)
    await DataAccessCenter.contentObject.retain(object.id, 1);
  if (withPreview)
    asset = await ensurePreviewForAsset({ asset, buffer, workspaceId });
  return withPreview ? asset : { ...asset, _sourceBuffer: buffer };
}

async function createImageAssetForUpload({
  workspaceId,
  userId = null,
  upload,
  env = process.env,
  fetchImpl = globalThis.fetch,
}) {
  if (!String(upload?.mimeType || "").startsWith("image/")) return null;
  const original = await DataAccessCenter.contentObject.assetForWorkspace({
    assetId: upload.contentObjectId,
    workspaceId,
  });
  if (!original) {
    const error = new Error("image_asset_original_not_found");
    error.code = "image_asset_original_not_found";
    throw error;
  }
  let asset = await ensureImageAssetForObject({
    workspaceId,
    userId,
    object: original,
    displayName: upload.displayName || "image",
    withPreview: false,
  });

  const previewTask = ensurePreviewForAsset({
    asset,
    buffer: asset._sourceBuffer,
    workspaceId,
  });

  const providerTask = syncImageAsset({
    assetId: asset.id,
    workspaceId,
    env,
    fetchImpl,
  });
  const [previewResult, providerResult] = await Promise.allSettled([
    previewTask,
    providerTask,
  ]);
  if (previewResult.status === "rejected") throw previewResult.reason;
  asset = previewResult.value;
  if (providerResult.status === "rejected") {
    asset = await DataAccessCenter.imageAsset.setProviderStatus(
      asset.id,
      "failed",
      providerResult.reason?.code || "provider_sync_failed"
    );
  } else {
    asset = providerResult.value;
  }
  return publicAsset(asset);
}

async function backfillImageAssetForAttachment({
  chat,
  ref,
  object,
  metadata = {},
}) {
  if (!chat?.workspaceId || !ref?.id || !object) return null;
  const asset = await ensureImageAssetForObject({
    workspaceId: chat.workspaceId,
    userId: chat.user_id || null,
    object,
    displayName: ref.displayName || metadata.originalName || "image",
    sourceSummary: String(chat.prompt || "").trim()
      ? `来源消息：${String(chat.prompt).replace(/\s+/g, " ").slice(0, 320)}`
      : null,
  });
  if (!asset) return null;
  await DataAccessCenter.imageAsset.bindAttachmentReference({
    attachmentRefId: ref.id,
    imageAssetId: asset.id,
  });
  await DataAccessCenter.imageAsset.linkSource({
    imageAssetId: asset.id,
    workspaceId: chat.workspaceId,
    threadId: chat.thread_id || null,
    chatId: chat.id,
    attachmentRefId: ref.id,
    ordinal: ref.ordinal || 0,
    sourceText: chat.prompt || null,
  });
  return asset;
}

async function syncImageAsset({
  assetId,
  workspaceId,
  env = process.env,
  fetchImpl = globalThis.fetch,
  forceRefresh = false,
}) {
  await DataAccessCenter.imageAsset.setProviderStatus(assetId, "syncing");
  try {
    await resolveImageInput(
      {
        kind: "persistent",
        assetId: String(assetId),
        name: "image",
        mimeType: "image/*",
        byteSize: 0,
        sha256: "",
        detail: "original",
      },
      { workspaceId, env, fetchImpl, forceRefresh }
    );
    return await DataAccessCenter.imageAsset.setProviderStatus(
      assetId,
      "ready"
    );
  } catch (error) {
    await DataAccessCenter.imageAsset
      .setProviderStatus(
        assetId,
        "failed",
        error.code || "provider_sync_failed"
      )
      .catch(() => null);
    throw error;
  }
}

async function assetForOwner({
  assetId,
  workspaceId,
  userId = null,
  includeDeleted = false,
}) {
  const owner =
    userId == null && workspaceId == null
      ? { ownerUserId: null, ownerScope: null }
      : imageAssetOwner({ userId, workspaceId });
  return DataAccessCenter.imageAsset.get({
    assetId,
    ...owner,
    includeDeleted,
  });
}

async function listImageAssets({
  userId = null,
  workspaceId = null,
  ...filters
}) {
  const owner =
    userId == null && workspaceId == null
      ? { ownerUserId: null, ownerScope: null }
      : imageAssetOwner({ userId, workspaceId });
  const result = await DataAccessCenter.imageAsset.list({
    ...owner,
    workspaceId,
    ...filters,
  });
  return { ...result, items: result.items.map(publicAsset) };
}

async function patchImageAsset({ assetId, workspaceId, userId = null, patch }) {
  const owner = imageAssetOwner({ userId, workspaceId });
  return publicAsset(
    await DataAccessCenter.imageAsset.patch({ assetId, ...owner, patch })
  );
}

async function previewObjectForAsset({ assetId, workspaceId, userId = null }) {
  const asset = await assetForOwner({ assetId, workspaceId, userId });
  if (!asset?.previewContentObjectId) return null;
  const object = await DataAccessCenter.contentObject.assetForWorkspace({
    assetId: asset.previewContentObjectId,
    workspaceId: asset.workspaceId,
  });
  return object ? { asset, object } : null;
}

async function deleteImageAsset({
  assetId,
  workspaceId,
  userId = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
}) {
  const owner = imageAssetOwner({ userId, workspaceId });
  const asset = await DataAccessCenter.imageAsset.beginDelete({
    assetId,
    ...owner,
  });
  if (!asset || asset.status === "deleted")
    return { completed: true, asset: publicAsset(asset) };
  // Tombstoning removes attachment rows from the live context immediately.
  // Release those references before provider cleanup so a failed remote delete
  // cannot lose the count needed by a later retry.
  if (asset.originalContentObjectId && asset.attachmentReferenceCount > 0)
    await DataAccessCenter.contentObject
      .release(asset.originalContentObjectId, asset.attachmentReferenceCount)
      .catch(() => null);
  const bindings =
    await DataAccessCenter.contentObject.providerFilesForImageAsset(asset.id);
  const failures = [];
  for (const binding of bindings) {
    try {
      await deleteDeepSeekFile(binding.providerFileId, { env, fetchImpl });
      await DataAccessCenter.contentObject.deleteProviderFileBinding(
        binding.id
      );
      if (binding.derivativeAssetId)
        await DataAccessCenter.contentObject
          .release(binding.derivativeAssetId, 1)
          .catch(() => null);
    } catch (error) {
      failures.push(error.code || "provider_delete_failed");
      await DataAccessCenter.contentObject
        .invalidateProviderFileBinding(
          binding.id,
          error.code || "provider_delete_failed"
        )
        .catch(() => null);
    }
  }
  if (failures.length) {
    await DataAccessCenter.imageAsset.setProviderStatus(
      asset.id,
      "delete_pending",
      failures[0]
    );
    return { completed: false, asset: publicAsset(asset), failures };
  }
  if (asset.previewContentObjectId)
    await DataAccessCenter.contentObject
      .release(asset.previewContentObjectId, 1)
      .catch(() => null);
  if (asset.originalContentObjectId)
    await DataAccessCenter.contentObject
      .release(asset.originalContentObjectId, 1)
      .catch(() => null);
  const deleted = await DataAccessCenter.imageAsset.finalizeDelete(asset.id);
  return { completed: true, asset: publicAsset(deleted) };
}

async function retryPendingImageAssetDeletes({ limit = 25 } = {}) {
  const pending = await DataAccessCenter.imageAsset.pendingDeletion(limit);
  const result = { inspected: pending.length, completed: 0, pending: 0 };
  for (const asset of pending) {
    const cleanup = await deleteImageAsset({
      assetId: asset.id,
      workspaceId: asset.workspaceId,
      userId: asset.ownerUserId,
    }).catch(() => ({ completed: false }));
    if (cleanup.completed) result.completed += 1;
    else result.pending += 1;
  }
  return result;
}

function deriveAssetMetadata(asset) {
  const sourceText = String(asset.sources?.[0]?.sourceText || "")
    .replace(/\s+/g, " ")
    .trim();
  const subtype = String(asset.mimeType || "")
    .split("/")[1]
    ?.toLowerCase();
  const tags = [
    "图片",
    subtype && subtype !== "octet-stream" ? subtype : null,
    asset.animated ? "动画" : null,
    asset.width && asset.height
      ? asset.width >= asset.height
        ? "横图"
        : "竖图"
      : null,
  ].filter(Boolean);
  const summary = sourceText
    ? `来源消息：${sourceText.slice(0, 320)}`
    : asset.summary || `用户图片：${String(asset.displayName || "image")}`;
  return { summary, tags: [...new Set(tags)] };
}

async function enrichPendingImageAssetMetadata({ limit = 25 } = {}) {
  const pending =
    await DataAccessCenter.imageAsset.pendingMetadataEnrichment(limit);
  const result = { inspected: pending.length, completed: 0, failed: 0 };
  for (const asset of pending) {
    try {
      await DataAccessCenter.imageAsset.applyMetadataEnrichment(
        asset.id,
        deriveAssetMetadata(asset)
      );
      result.completed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

async function runImageAssetMaintenance({ limit = 25 } = {}) {
  const [deletions, metadata] = await Promise.all([
    retryPendingImageAssetDeletes({ limit }),
    enrichPendingImageAssetMetadata({ limit }),
  ]);
  return { priority: "P2", deletions, metadata };
}

module.exports = {
  PREVIEW_DOMAIN,
  PREVIEW_MAX_EDGE,
  PREVIEW_QUALITY,
  assetForOwner,
  backfillImageAssetForAttachment,
  createImageAssetForUpload,
  deleteImageAsset,
  imageAssetOwner,
  imageAssetPreviewUrl,
  listImageAssets,
  makePreview,
  ensureImageAssetForObject,
  enrichPendingImageAssetMetadata,
  patchImageAsset,
  previewObjectForAsset,
  publicAsset,
  retryPendingImageAssetDeletes,
  runImageAssetMaintenance,
  syncImageAsset,
};
