const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const prisma = require("../utils/prisma");
const { safeJsonParse } = require("../utils/http");
const { normalizePath, isWithin } = require("../utils/files");
const {
  validateImageBuffer,
} = require("../utils/visualAssets/imageMetadata");

const VALID_SCOPES = new Set(["workspace", "node"]);
const DEFAULT_ROLE = "hero_background";
let tableReady = false;

function assetsRoot() {
  return process.env.STORAGE_DIR
    ? path.join(process.env.STORAGE_DIR, "assets", "overview-backgrounds")
    : path.join(__dirname, "../storage/assets/overview-backgrounds");
}

function safeJSONStringify(value = {}, fallback = "{}") {
  try {
    return JSON.stringify(value || {});
  } catch {
    return fallback;
  }
}

function normalizeScopeType(value = "workspace") {
  return VALID_SCOPES.has(value) ? value : "workspace";
}

function publicUrl({ workspaceSlug, asset }) {
  if (!workspaceSlug || !asset?.id) return null;
  const version = encodeURIComponent(asset.updatedAt || asset.createdAt || "");
  return `/api/workspace/${workspaceSlug}/visual-assets/${asset.id}/file?v=${version}`;
}

function normalizeRow(row = null, { workspaceSlug = null } = {}) {
  if (!row) return null;
  const metadata = safeJsonParse(row.metadataJson || row.metadata, {});
  const asset = {
    id: Number(row.id),
    workspaceId: Number(row.workspaceId),
    scopeType: normalizeScopeType(row.scopeType),
    nodeKey: row.nodeKey || null,
    nodeLabel: row.nodeLabel || null,
    nodeType: row.nodeType || null,
    role: row.role || DEFAULT_ROLE,
    filename: row.filename,
    mime: row.mime,
    size: Number(row.size || 0),
    metadata,
    imageWidth: metadata.imageWidth || null,
    imageHeight: metadata.imageHeight || null,
    dominantColor: metadata.dominantColor || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  return {
    ...asset,
    url: publicUrl({ workspaceSlug, asset }),
  };
}

async function ensureTable() {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "WorkspaceVisualAsset" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "workspaceId" INTEGER NOT NULL,
      "scopeType" TEXT NOT NULL DEFAULT 'workspace',
      "nodeKey" TEXT,
      "nodeLabel" TEXT,
      "nodeType" TEXT,
      "role" TEXT NOT NULL DEFAULT '${DEFAULT_ROLE}',
      "filename" TEXT NOT NULL,
      "mime" TEXT NOT NULL,
      "size" INTEGER NOT NULL DEFAULT 0,
      "metadataJson" TEXT NOT NULL DEFAULT '{}',
      "deletedAt" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceVisualAsset_workspace_scope_node_role_key"
    ON "WorkspaceVisualAsset"("workspaceId","scopeType",COALESCE("nodeKey",'__workspace__'),"role")
    WHERE "deletedAt" IS NULL
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "WorkspaceVisualAsset_workspace_scope_idx"
    ON "WorkspaceVisualAsset"("workspaceId","scopeType","role")
  `);
  tableReady = true;
}

function filepathFor(filename = "") {
  const root = assetsRoot();
  const filePath = path.join(root, normalizePath(filename));
  if (!isWithin(path.resolve(root), path.resolve(filePath)))
    throw new Error("invalid_asset_path");
  return filePath;
}

function safeUnlink(filename = "") {
  if (!filename) return;
  try {
    const filePath = filepathFor(filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (error) {
    console.warn("[WorkspaceVisualAsset] failed to delete physical file", {
      filename,
      error: error.message,
    });
  }
}

async function currentAsset({
  workspaceId,
  scopeType = "workspace",
  nodeKey = null,
  role = DEFAULT_ROLE,
}) {
  const normalizedScope = normalizeScopeType(scopeType);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT *, CAST("createdAt" AS TEXT) AS "createdAt",
      CAST("updatedAt" AS TEXT) AS "updatedAt"
    FROM "WorkspaceVisualAsset"
    WHERE "workspaceId" = ? AND "scopeType" = ? AND "role" = ?
      AND "deletedAt" IS NULL
      AND COALESCE("nodeKey", '__workspace__') = COALESCE(?, '__workspace__')
    ORDER BY "updatedAt" DESC, "id" DESC
    LIMIT 1`,
    Number(workspaceId),
    normalizedScope,
    role,
    normalizedScope === "node" ? String(nodeKey || "") : null
  );
  return rows?.[0] || null;
}

const WorkspaceVisualAsset = {
  DEFAULT_ROLE,
  ensureTable,
  assetsRoot,
  normalizeRow,
  publicUrl,

  async list({
    workspaceId,
    workspaceSlug = null,
    scopeType = null,
    nodeKey = null,
    role = DEFAULT_ROLE,
  }) {
    await ensureTable();
    if (!workspaceId) return [];
    const clauses = [`"workspaceId" = ?`, `"deletedAt" IS NULL`];
    const params = [Number(workspaceId)];
    if (scopeType) {
      clauses.push(`"scopeType" = ?`);
      params.push(normalizeScopeType(scopeType));
    }
    if (nodeKey) {
      clauses.push(`"nodeKey" = ?`);
      params.push(String(nodeKey));
    }
    if (role) {
      clauses.push(`"role" = ?`);
      params.push(String(role));
    }
    const rows = await prisma.$queryRawUnsafe(
      `SELECT *, CAST("createdAt" AS TEXT) AS "createdAt",
        CAST("updatedAt" AS TEXT) AS "updatedAt"
      FROM "WorkspaceVisualAsset"
      WHERE ${clauses.join(" AND ")}
      ORDER BY "updatedAt" DESC, "id" DESC`,
      ...params
    );
    return rows.map((row) => normalizeRow(row, { workspaceSlug }));
  },

  async forWorkspace({ workspaceId, workspaceSlug = null }) {
    await ensureTable();
    const row = await currentAsset({ workspaceId, scopeType: "workspace" });
    return normalizeRow(row, { workspaceSlug });
  },

  async forNode({ workspaceId, workspaceSlug = null, nodeKey = null }) {
    await ensureTable();
    if (!nodeKey) return null;
    const row = await currentAsset({ workspaceId, scopeType: "node", nodeKey });
    return normalizeRow(row, { workspaceSlug });
  },

  async upsertFromUpload({
    workspaceId,
    workspaceSlug = null,
    scopeType = "workspace",
    nodeKey = null,
    nodeLabel = null,
    nodeType = null,
    role = DEFAULT_ROLE,
    file = null,
    uploadedBy = null,
  }) {
    await ensureTable();
    if (!workspaceId || !file?.buffer)
      return { success: false, error: "missing_image" };
    const normalizedScope = normalizeScopeType(scopeType);
    if (normalizedScope === "node" && !nodeKey)
      return { success: false, error: "nodeKey_required" };

    const validation = validateImageBuffer(file.buffer, {
      scopeType: normalizedScope,
    });
    if (!validation.valid)
      return { success: false, error: validation.error };

    const existing = await currentAsset({
      workspaceId,
      scopeType: normalizedScope,
      nodeKey,
      role,
    });
    const root = assetsRoot();
    fs.mkdirSync(root, { recursive: true });
    const filename = `${uuidv4()}${validation.ext}`;
    fs.writeFileSync(filepathFor(filename), file.buffer);

    if (existing) {
      await prisma.$executeRawUnsafe(
        `UPDATE "WorkspaceVisualAsset"
        SET "deletedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ?`,
        Number(existing.id)
      );
      safeUnlink(existing.filename);
    }

    const metadata = {
      imageWidth: validation.imageWidth,
      imageHeight: validation.imageHeight,
      dominantColor: validation.dominantColor,
      uploadedBy: uploadedBy ? Number(uploadedBy) : null,
      replacedAssetId: existing?.id ? Number(existing.id) : null,
      checksum: validation.checksum,
      originalName: file.originalname || null,
    };
    await prisma.$executeRawUnsafe(
      `INSERT INTO "WorkspaceVisualAsset" (
        "workspaceId", "scopeType", "nodeKey", "nodeLabel", "nodeType", "role",
        "filename", "mime", "size", "metadataJson", "createdAt", "updatedAt"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      Number(workspaceId),
      normalizedScope,
      normalizedScope === "node" ? String(nodeKey) : null,
      normalizedScope === "node" ? String(nodeLabel || "") : null,
      normalizedScope === "node" ? String(nodeType || "concept") : null,
      String(role || DEFAULT_ROLE),
      filename,
      validation.mime,
      Number(validation.size),
      safeJSONStringify(metadata)
    );
    const row = await currentAsset({
      workspaceId,
      scopeType: normalizedScope,
      nodeKey,
      role,
    });
    return {
      success: true,
      asset: normalizeRow(row, { workspaceSlug }),
    };
  },

  async get({ workspaceId, id, workspaceSlug = null }) {
    await ensureTable();
    const row = (
      await prisma.$queryRawUnsafe(
        `SELECT *, CAST("createdAt" AS TEXT) AS "createdAt",
          CAST("updatedAt" AS TEXT) AS "updatedAt"
        FROM "WorkspaceVisualAsset"
        WHERE "workspaceId" = ? AND "id" = ? AND "deletedAt" IS NULL
        LIMIT 1`,
        Number(workspaceId),
        Number(id)
      )
    )?.[0];
    return normalizeRow(row, { workspaceSlug });
  },

  async fileFor({ workspaceId, id }) {
    const asset = await this.get({ workspaceId, id });
    if (!asset) return null;
    const filePath = filepathFor(asset.filename);
    if (!fs.existsSync(filePath)) return null;
    return { asset, filePath };
  },

  async delete({ workspaceId, id }) {
    await ensureTable();
    const asset = await this.get({ workspaceId, id });
    if (!asset) return { success: false, error: "asset_not_found" };
    await prisma.$executeRawUnsafe(
      `UPDATE "WorkspaceVisualAsset"
      SET "deletedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "workspaceId" = ? AND "id" = ?`,
      Number(workspaceId),
      Number(id)
    );
    safeUnlink(asset.filename);
    return { success: true, asset };
  },
};

module.exports = { WorkspaceVisualAsset };
