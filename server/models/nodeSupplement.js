const prisma = require("../utils/prisma");
const { safeJsonParse } = require("../utils/http");
const {
  buildNodeKey,
  isStableNodeKey,
  nodeKeyCandidates,
} = require("../utils/knowledgeGraph/nodeIdentity");
const {
  resolveNodeIdentity,
} = require("../utils/knowledgeGraph/nodeIdentityResolver");

let tableReady = false;

function safeJSONStringify(value = {}, fallback = "{}") {
  try {
    return JSON.stringify(value || {});
  } catch {
    return fallback;
  }
}

function normalizeRow(row = null) {
  if (!row) return null;
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspaceId),
    nodeId:
      row.nodeId === null || row.nodeId === undefined
        ? null
        : Number(row.nodeId),
    nodeKey: row.nodeKey,
    nodeLabel: row.nodeLabel,
    nodeType: row.nodeType,
    documentId: row.documentId,
    documentName: row.documentName,
    priority: Number(row.priority || 0),
    metadata: safeJsonParse(row.metadata, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function documentDisplayName(document = {}, metadata = {}) {
  const documentMetadata = safeJsonParse(document.metadata, {});
  return (
    metadata.documentName ||
    metadata.displayTitle ||
    metadata.title ||
    documentMetadata.documentName ||
    documentMetadata.displayTitle ||
    documentMetadata.title ||
    document.filename ||
    document.docpath ||
    document.docId
  );
}

async function ensureTable() {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "NodeSupplement" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "workspaceId" INTEGER NOT NULL,
      "nodeId" INTEGER,
      "nodeKey" TEXT NOT NULL,
      "nodeLabel" TEXT NOT NULL,
      "nodeType" TEXT NOT NULL DEFAULT 'concept',
      "documentId" TEXT NOT NULL,
      "documentName" TEXT NOT NULL,
      "priority" INTEGER NOT NULL DEFAULT 0,
      "metadata" TEXT NOT NULL DEFAULT '{}',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "NodeSupplement_workspaceId_nodeKey_documentId_key"
    ON "NodeSupplement"("workspaceId", "nodeKey", "documentId")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "NodeSupplement_workspaceId_nodeKey_idx"
    ON "NodeSupplement"("workspaceId", "nodeKey")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "NodeSupplement_workspaceId_documentId_idx"
    ON "NodeSupplement"("workspaceId", "documentId")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "NodeSupplement_workspaceId_nodeId_idx"
    ON "NodeSupplement"("workspaceId", "nodeId")
  `);
  tableReady = true;
}

async function resolveSupplementNode({
  workspaceId,
  nodeId = null,
  nodeKey = null,
  canonicalKey = null,
  nodeLabel = null,
} = {}) {
  const identity = await resolveNodeIdentity({
    workspaceId,
    nodeId,
    nodeKey,
    canonicalKey,
    label: nodeLabel,
  });
  if (!identity.success) return identity;
  return {
    success: true,
    node: {
      id: identity.node.nodeId,
      canonicalName: identity.node.canonicalName,
      canonicalKey: identity.node.canonicalKey,
      entityType: identity.node.nodeType,
      displayNameZh: identity.node.displayNameZh,
      displayNameEn: identity.node.displayNameEn,
      nodeKey: identity.node.nodeKey,
      identitySource: identity.node.identitySource,
    },
  };
}

const NodeSupplement = {
  buildNodeKey,
  ensureTable,

  async list({ workspaceId, nodeKey }) {
    await ensureTable();
    if (!workspaceId || !nodeKey) return [];
    const keys = nodeKeyCandidates(nodeKey);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT * FROM "NodeSupplement"
      WHERE "workspaceId" = ? AND "nodeKey" IN (${keys.map(() => "?").join(",")})
      ORDER BY "priority" DESC, "updatedAt" DESC, "id" DESC`,
      Number(workspaceId),
      ...keys
    );
    return rows.map(normalizeRow);
  },

  async summariesByNodeKeys({ workspaceId, nodeKeys = [] }) {
    await ensureTable();
    const uniqueKeys = [
      ...new Set(nodeKeys.filter(Boolean).flatMap(nodeKeyCandidates)),
    ];
    if (!workspaceId || uniqueKeys.length === 0) return new Map();
    const rows = await prisma.$queryRawUnsafe(
      `SELECT * FROM "NodeSupplement"
      WHERE "workspaceId" = ? AND "nodeKey" IN (${uniqueKeys
        .map(() => "?")
        .join(",")})
      ORDER BY "priority" DESC, "updatedAt" DESC, "id" DESC`,
      Number(workspaceId),
      ...uniqueKeys
    );
    const map = new Map();
    rows.map(normalizeRow).forEach((row) => {
      const current = map.get(row.nodeKey) || [];
      current.push(row);
      map.set(row.nodeKey, current);
    });
    return map;
  },

  async upsert({
    workspaceId,
    nodeId = null,
    nodeKey,
    nodeLabel,
    nodeType = "concept",
    canonicalKey = null,
    documentId,
    priority = 0,
    metadata = {},
  }) {
    await ensureTable();
    if (!workspaceId || !documentId)
      return { success: false, error: "missing_required_fields" };
    if (nodeKey && !isStableNodeKey(nodeKey))
      return { success: false, error: "invalid_node_key" };

    const resolved = await resolveSupplementNode({
      workspaceId,
      nodeId,
      nodeKey,
      canonicalKey,
      nodeLabel,
    });
    if (!resolved.success)
      return {
        success: false,
        error: resolved.reason || "node_not_found",
        candidates: resolved.candidates || [],
      };
    const node = resolved.node;

    const document = (
      await prisma.$queryRawUnsafe(
        `SELECT "docId", "filename", "docpath", "metadata" FROM "workspace_documents"
        WHERE "workspaceId" = ? AND "docId" = ? LIMIT 1`,
        Number(workspaceId),
        String(documentId)
      )
    )?.[0];
    if (!document) return { success: false, error: "document_not_found" };

    const finalNodeId = Number(node.id);
    const finalNodeLabel =
      node.displayNameZh ||
      node.canonicalName ||
      node.displayNameEn ||
      String(nodeLabel || "").trim() ||
      nodeKey;
    const finalNodeType = String(node.entityType || nodeType || "concept");
    const finalNodeKey = buildNodeKey({
      entityType: node.entityType,
      canonicalKey: node.canonicalKey,
    });
    const documentName = documentDisplayName(document, metadata);

    await prisma.$executeRawUnsafe(
      `INSERT INTO "NodeSupplement" (
        "workspaceId", "nodeId", "nodeKey", "nodeLabel", "nodeType",
        "documentId", "documentName", "priority", "metadata", "createdAt", "updatedAt"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT("workspaceId", "nodeKey", "documentId") DO UPDATE SET
        "nodeId" = excluded."nodeId",
        "nodeLabel" = excluded."nodeLabel",
        "nodeType" = excluded."nodeType",
        "documentName" = excluded."documentName",
        "priority" = excluded."priority",
        "metadata" = excluded."metadata",
        "updatedAt" = CURRENT_TIMESTAMP`,
      Number(workspaceId),
      finalNodeId,
      finalNodeKey,
      finalNodeLabel,
      finalNodeType,
      String(documentId),
      documentName,
      Number(priority || 0),
      safeJSONStringify(metadata)
    );

    const row = (
      await prisma.$queryRawUnsafe(
        `SELECT * FROM "NodeSupplement"
        WHERE "workspaceId" = ? AND "nodeKey" = ? AND "documentId" = ?
        LIMIT 1`,
        Number(workspaceId),
        finalNodeKey,
        String(documentId)
      )
    )?.[0];
    return { success: true, supplement: normalizeRow(row) };
  },

  async delete({ workspaceId, id }) {
    await ensureTable();
    const row = (
      await prisma.$queryRawUnsafe(
        `SELECT * FROM "NodeSupplement" WHERE "workspaceId" = ? AND "id" = ? LIMIT 1`,
        Number(workspaceId),
        Number(id)
      )
    )?.[0];
    if (!row) return { success: false, error: "supplement_not_found" };
    await prisma.$executeRawUnsafe(
      `DELETE FROM "NodeSupplement" WHERE "workspaceId" = ? AND "id" = ?`,
      Number(workspaceId),
      Number(id)
    );
    return { success: true, supplement: normalizeRow(row) };
  },

  async deleteForDocument({ workspaceId, documentId }) {
    await ensureTable();
    if (!workspaceId || !documentId) return false;
    await prisma.$executeRawUnsafe(
      `DELETE FROM "NodeSupplement" WHERE "workspaceId" = ? AND "documentId" = ?`,
      Number(workspaceId),
      String(documentId)
    );
    return true;
  },
};

module.exports = { NodeSupplement };
