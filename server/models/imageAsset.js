const crypto = require("crypto");
const prisma = require("../utils/prisma");

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function serialize(row) {
  if (!row) return null;
  return {
    ...row,
    tags: parseJson(row.tagsJson || "[]", []),
    tagsJson: undefined,
  };
}

function ownerWhere({ ownerUserId = null, ownerScope = null } = {}) {
  if (ownerUserId != null) return { ownerUserId: Number(ownerUserId) };
  if (ownerScope) return { ownerScope: String(ownerScope) };
  return { ownerUserId: null };
}

const ImageAsset = {
  async ensure({
    ownerUserId = null,
    ownerScope,
    workspaceId,
    originalContentObjectId,
    displayName,
    mimeType,
    byteSize,
    width = null,
    height = null,
    animated = false,
    summary = null,
  }) {
    const where = {
      ownerScope_workspaceId_originalContentObjectId: {
        ownerScope: String(ownerScope),
        workspaceId: Number(workspaceId),
        originalContentObjectId: String(originalContentObjectId),
      },
    };
    const existing = await prisma.image_assets.findUnique({ where });
    if (existing) {
      const row = await prisma.image_assets.update({
        where: { id: existing.id },
        data: {
          displayName: String(displayName || "image").slice(0, 255),
          mimeType: String(mimeType || "application/octet-stream").slice(0, 160),
          byteSize: Number(byteSize || 0),
          width: width == null ? null : Number(width),
          height: height == null ? null : Number(height),
          animated: Boolean(animated),
          deletedAt: null,
          ...(summary ? { summary: String(summary).slice(0, 1_000) } : {}),
        },
      });
      return { ...serialize(row), _created: false };
    }
    try {
      const row = await prisma.image_assets.create({
        data: {
        id: crypto.randomUUID(),
        ownerUserId: ownerUserId == null ? null : Number(ownerUserId),
        ownerScope: String(ownerScope),
        workspaceId: Number(workspaceId),
        originalContentObjectId: String(originalContentObjectId),
        displayName: String(displayName || "image").slice(0, 255),
        mimeType: String(mimeType || "application/octet-stream").slice(0, 160),
        byteSize: Number(byteSize || 0),
        width: width == null ? null : Number(width),
        height: height == null ? null : Number(height),
        animated: Boolean(animated),
        summary: summary ? String(summary).slice(0, 1_000) : null,
        },
      });
      return { ...serialize(row), _created: true };
    } catch (error) {
      if (error?.code !== "P2002") throw error;
      const winner = await prisma.image_assets.findUnique({ where });
      return winner ? { ...serialize(winner), _created: false } : null;
    }
  },

  async setPreview(assetId, { previewContentObjectId, width, height }) {
    return serialize(
      await prisma.image_assets.update({
        where: { id: String(assetId) },
        data: {
          previewContentObjectId: String(previewContentObjectId),
          previewWidth: Number(width || 0) || null,
          previewHeight: Number(height || 0) || null,
          status: "local_ready",
        },
      })
    );
  },

  async get({ assetId, ownerUserId = null, ownerScope = null, includeDeleted = false }) {
    const row = await prisma.image_assets.findFirst({
      where: {
        id: String(assetId),
        ...ownerWhere({ ownerUserId, ownerScope }),
        ...(includeDeleted ? {} : { status: { notIn: ["deleting", "deleted"] } }),
      },
    });
    return serialize(row);
  },

  async getForModel({ assetId, workspaceId }) {
    const row = await prisma.image_assets.findFirst({
      where: {
        id: String(assetId),
        workspaceId: Number(workspaceId),
        status: { notIn: ["deleting", "deleted"] },
        originalContentObjectId: { not: null },
      },
    });
    if (row)
      await prisma.image_assets.update({
        where: { id: row.id },
        data: { lastUsedAt: new Date() },
      });
    return serialize(row);
  },

  async list({
    ownerUserId = null,
    ownerScope = null,
    workspaceId = null,
    threadId = null,
    status = "active",
    page = 1,
    limit = 24,
  }) {
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 24));
    const safePage = Math.max(1, Number(page) || 1);
    const sourceFilter = threadId == null ? null : { threadId: Number(threadId) };
    let sourceAssetIds = null;
    if (sourceFilter) {
      const rows = await prisma.image_asset_sources.findMany({
        where: sourceFilter,
        select: { imageAssetId: true },
      });
      sourceAssetIds = [...new Set(rows.map((row) => row.imageAssetId))];
    }
    const where = {
      ...ownerWhere({ ownerUserId, ownerScope }),
      ...(workspaceId == null ? {} : { workspaceId: Number(workspaceId) }),
      ...(status === "all"
        ? {}
        : status === "deleted"
          ? { status: "deleted" }
          : { status: { notIn: ["deleting", "deleted"] } }),
      ...(sourceAssetIds ? { id: { in: sourceAssetIds } } : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.image_assets.count({ where }),
      prisma.image_assets.findMany({
        where,
        orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
    ]);
    const ids = rows.map((row) => row.id);
    const sources = ids.length
      ? await prisma.image_asset_sources.findMany({
          where: { imageAssetId: { in: ids } },
          orderBy: { createdAt: "desc" },
        })
      : [];
    const groupedSources = new Map();
    for (const source of sources) {
      if (!groupedSources.has(source.imageAssetId)) groupedSources.set(source.imageAssetId, []);
      groupedSources.get(source.imageAssetId).push(source);
    }
    return {
      items: rows.map((row) => ({
        ...serialize(row),
        sources: groupedSources.get(row.id) || [],
      })),
      page: safePage,
      limit: safeLimit,
      total,
      hasMore: safePage * safeLimit < total,
    };
  },

  async search({ ownerUserId = null, ownerScope = null, workspaceId, query = "", limit = 12 }) {
    const terms = String(query || "").trim().slice(0, 200);
    const rows = await prisma.image_assets.findMany({
      where: {
        ...ownerWhere({ ownerUserId, ownerScope }),
        workspaceId: Number(workspaceId),
        status: { notIn: ["deleting", "deleted"] },
        ...(terms
          ? {
              OR: [
                { displayName: { contains: terms } },
                { title: { contains: terms } },
                { summary: { contains: terms } },
                { tagsJson: { contains: terms } },
              ],
            }
          : {}),
      },
      orderBy: [{ pinned: "desc" }, { lastUsedAt: "desc" }, { createdAt: "desc" }],
      take: Math.min(32, Math.max(1, Number(limit) || 12)),
    });
    return rows.map(serialize);
  },

  async patch({ assetId, ownerUserId = null, ownerScope = null, patch = {} }) {
    const current = await this.get({ assetId, ownerUserId, ownerScope });
    if (!current) return null;
    if (patch.pinned === true && !current.pinned) {
      const pinnedCount = await prisma.image_assets.count({
        where: {
          ...ownerWhere({ ownerUserId, ownerScope }),
          workspaceId: current.workspaceId,
          pinned: true,
          status: { notIn: ["deleting", "deleted"] },
        },
      });
      if (pinnedCount >= 3) {
        const error = new Error("image_asset_pin_limit_reached");
        error.code = "image_asset_pin_limit_reached";
        throw error;
      }
    }
    const data = {};
    if (typeof patch.pinned === "boolean") data.pinned = patch.pinned;
    if (Object.prototype.hasOwnProperty.call(patch, "title"))
      data.title = patch.title ? String(patch.title).slice(0, 255) : null;
    if (Object.prototype.hasOwnProperty.call(patch, "summary"))
      data.summary = patch.summary ? String(patch.summary).slice(0, 1_000) : null;
    if (Array.isArray(patch.tags))
      data.tagsJson = JSON.stringify(
        patch.tags.map((tag) => String(tag).trim().slice(0, 80)).filter(Boolean).slice(0, 24)
      );
    return serialize(
      await prisma.image_assets.update({ where: { id: current.id }, data })
    );
  },

  async setProviderStatus(assetId, status, failureCode = null) {
    return serialize(
      await prisma.image_assets.update({
        where: { id: String(assetId) },
        data: {
          providerSyncStatus: String(status),
          providerFailureCode: failureCode ? String(failureCode).slice(0, 160) : null,
          ...(status === "ready" ? { status: "ready" } : {}),
        },
      })
    );
  },

  async linkSource({ imageAssetId, workspaceId, threadId = null, chatId, attachmentRefId, ordinal = 0, sourceText = null }) {
    return prisma.image_asset_sources.upsert({
      where: {
        imageAssetId_attachmentRefId: {
          imageAssetId: String(imageAssetId),
          attachmentRefId: String(attachmentRefId),
        },
      },
      create: {
        id: crypto.randomUUID(),
        imageAssetId: String(imageAssetId),
        workspaceId: Number(workspaceId),
        threadId: threadId == null ? null : Number(threadId),
        chatId: Number(chatId),
        attachmentRefId: String(attachmentRefId),
        ordinal: Number(ordinal || 0),
        sourceText: sourceText ? String(sourceText).slice(0, 1_000) : null,
      },
      update: {
        threadId: threadId == null ? null : Number(threadId),
        chatId: Number(chatId),
        ordinal: Number(ordinal || 0),
        sourceText: sourceText ? String(sourceText).slice(0, 1_000) : null,
      },
    });
  },

  async bindAttachmentReference({ attachmentRefId, imageAssetId }) {
    return prisma.workspace_chat_attachment_refs.update({
      where: { id: String(attachmentRefId) },
      data: {
        imageAssetId: String(imageAssetId),
        status: "active",
        deletedAt: null,
      },
    });
  },

  async pendingDeletion(limit = 25) {
    return prisma.image_assets.findMany({
      where: {
        status: "deleting",
        providerSyncStatus: "delete_pending",
      },
      orderBy: { updatedAt: "asc" },
      take: Math.min(100, Math.max(1, Number(limit) || 25)),
    });
  },

  async pendingMetadataEnrichment(limit = 25) {
    return prisma.image_assets.findMany({
      where: {
        status: { notIn: ["deleting", "deleted"] },
        lastUsedAt: { not: null },
        tagsJson: "[]",
      },
      include: {
        sources: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy: { lastUsedAt: "asc" },
      take: Math.min(100, Math.max(1, Number(limit) || 25)),
    });
  },

  async applyMetadataEnrichment(assetId, { summary = null, tags = [] } = {}) {
    const normalizedTags = Array.isArray(tags)
      ? tags
          .map((tag) => String(tag || "").trim().slice(0, 80))
          .filter(Boolean)
          .slice(0, 24)
      : [];
    return serialize(
      await prisma.image_assets.update({
        where: { id: String(assetId) },
        data: {
          ...(summary ? { summary: String(summary).slice(0, 1_000) } : {}),
          tagsJson: JSON.stringify(normalizedTags),
        },
      })
    );
  },

  async beginDelete({ assetId, ownerUserId = null, ownerScope = null }) {
    const asset = await this.get({ assetId, ownerUserId, ownerScope, includeDeleted: true });
    if (!asset || asset.status === "deleted") return asset;
    const refs = await prisma.workspace_chat_attachment_refs.findMany({
      where: { imageAssetId: asset.id, status: "active" },
    });
    await prisma.$transaction([
      prisma.image_assets.update({
        where: { id: asset.id },
        data: { status: "deleting", pinned: false, deletedAt: new Date() },
      }),
      prisma.workspace_chat_attachment_refs.updateMany({
        where: { imageAssetId: asset.id },
        data: {
          contentObjectId: null,
          status: "deleted",
          deletedAt: new Date(),
          metadataJson: JSON.stringify({ tombstone: "user_deleted" }),
        },
      }),
    ]);
    return { ...asset, status: "deleting", attachmentReferenceCount: refs.length };
  },

  async finalizeDelete(assetId) {
    const now = new Date();
    return serialize(
      await prisma.image_assets.update({
        where: { id: String(assetId) },
        data: {
          originalContentObjectId: null,
          previewContentObjectId: null,
          displayName: "图片已由用户删除",
          mimeType: "application/x-athena-image-tombstone",
          byteSize: 0,
          width: null,
          height: null,
          previewWidth: null,
          previewHeight: null,
          title: null,
          summary: null,
          tagsJson: "[]",
          status: "deleted",
          providerSyncStatus: "deleted",
          providerFailureCode: null,
          pinned: false,
          lastUsedAt: null,
          deletedAt: now,
        },
      })
    );
  },
};

module.exports = { ImageAsset, ownerWhere, serialize };
