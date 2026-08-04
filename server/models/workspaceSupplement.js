const prisma = require("../utils/prisma");
const {
  ensureMigrationOwnedTables,
} = require("../utils/database/schemaIntrospection");
const { safeJsonParse } = require("../utils/http");
const {
  normalizeScopeType,
  normalizeSupplementKind,
  supplementKindWeight,
} = require("../utils/knowledgeGraph/supplementConstants");

let tableReady = false;

function safeJSONStringify(value = {}, fallback = "{}") {
  try {
    return JSON.stringify(value || {});
  } catch {
    return fallback;
  }
}

function normalizePrimaryDocumentId(value = null) {
  const text = String(value || "").trim();
  return text || "__workspace__";
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

function normalizeRow(row = null) {
  if (!row) return null;
  const supplementKind = normalizeSupplementKind(row.supplementKind);
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspaceId),
    scopeType: normalizeScopeType(row.scopeType),
    primaryDocumentId:
      row.primaryDocumentId === "__workspace__" ? null : row.primaryDocumentId,
    documentId: row.documentId,
    documentName: row.documentName,
    supplementKind,
    weight: supplementKindWeight(supplementKind),
    priority: Number(row.priority || 0),
    metadata: safeJsonParse(row.metadata, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function ensureTable() {
  if (tableReady) return;
  if (
    await ensureMigrationOwnedTables(prisma, ["WorkspaceSupplement"], {
      context: "workspace-supplement",
    })
  ) {
    tableReady = true;
    return;
  }
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "WorkspaceSupplement" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "workspaceId" INTEGER NOT NULL,
      "scopeType" TEXT NOT NULL DEFAULT 'workspace',
      "primaryDocumentId" TEXT NOT NULL DEFAULT '__workspace__',
      "documentId" TEXT NOT NULL,
      "documentName" TEXT NOT NULL,
      "supplementKind" TEXT NOT NULL DEFAULT 'other',
      "priority" INTEGER NOT NULL DEFAULT 0,
      "metadata" TEXT NOT NULL DEFAULT '{}',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceSupplement_workspace_scope_primary_document_key"
    ON "WorkspaceSupplement"("workspaceId","scopeType","primaryDocumentId","documentId")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "WorkspaceSupplement_workspace_scope_kind_idx"
    ON "WorkspaceSupplement"("workspaceId","scopeType","supplementKind")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "WorkspaceSupplement_workspace_document_idx"
    ON "WorkspaceSupplement"("workspaceId","documentId")
  `);
  tableReady = true;
}

const WorkspaceSupplement = {
  ensureTable,

  async list({
    workspaceId,
    scopeType = null,
    primaryDocumentId = undefined,
    limit = 100,
  }) {
    await ensureTable();
    if (!workspaceId) return [];
    const clauses = [`ws."workspaceId" = ?`];
    const params = [Number(workspaceId)];
    if (scopeType) {
      clauses.push(`ws."scopeType" = ?`);
      params.push(normalizeScopeType(scopeType));
    }
    if (primaryDocumentId !== undefined) {
      clauses.push(`ws."primaryDocumentId" = ?`);
      params.push(normalizePrimaryDocumentId(primaryDocumentId));
    }
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ws.*, CAST(ws."createdAt" AS TEXT) AS "createdAt",
        CAST(ws."updatedAt" AS TEXT) AS "updatedAt"
      FROM "WorkspaceSupplement" AS ws
      WHERE ${clauses.join(" AND ")}
      ORDER BY ws."priority" DESC, ws."updatedAt" DESC, ws."id" DESC
      LIMIT ?`,
      ...params,
      Number(limit || 100)
    );
    return rows.map(normalizeRow);
  },

  async summary({ workspaceId }) {
    await ensureTable();
    if (!workspaceId) return { count: 0, byKind: {}, supplements: [] };
    const supplements = await this.list({ workspaceId, limit: 200 });
    const byKind = {};
    for (const supplement of supplements) {
      byKind[supplement.supplementKind] =
        (byKind[supplement.supplementKind] || 0) + 1;
    }
    return {
      count: supplements.length,
      byKind,
      supplements: supplements.slice(0, 8),
    };
  },

  async weighted({ workspaceId, scopeType = null, limit = 20 }) {
    const supplements = await this.list({ workspaceId, scopeType, limit: 200 });
    return supplements
      .sort(
        (a, b) =>
          b.weight + b.priority * 2 - (a.weight + a.priority * 2) ||
          new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)
      )
      .slice(0, limit);
  },

  async upsert({
    workspaceId,
    scopeType = "workspace",
    primaryDocumentId = null,
    documentId,
    supplementKind = "other",
    priority = 0,
    metadata = {},
  }) {
    await ensureTable();
    if (!workspaceId || !documentId)
      return { success: false, error: "missing_required_fields" };
    const document = (
      await prisma.$queryRawUnsafe(
        `SELECT "docId", "filename", "docpath", "metadata" FROM "workspace_documents"
        WHERE "workspaceId" = ? AND "docId" = ? LIMIT 1`,
        Number(workspaceId),
        String(documentId)
      )
    )?.[0];
    if (!document) return { success: false, error: "document_not_found" };

    const finalScopeType = normalizeScopeType(scopeType);
    const finalKind = normalizeSupplementKind(supplementKind);
    const finalPrimaryDocumentId =
      normalizePrimaryDocumentId(primaryDocumentId);
    const documentName = documentDisplayName(document, metadata);

    await prisma.$executeRawUnsafe(
      `INSERT INTO "WorkspaceSupplement" (
        "workspaceId", "scopeType", "primaryDocumentId", "documentId",
        "documentName", "supplementKind", "priority", "metadata",
        "createdAt", "updatedAt"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT("workspaceId", "scopeType", "primaryDocumentId", "documentId")
      DO UPDATE SET
        "documentName" = excluded."documentName",
        "supplementKind" = excluded."supplementKind",
        "priority" = excluded."priority",
        "metadata" = excluded."metadata",
        "updatedAt" = CURRENT_TIMESTAMP`,
      Number(workspaceId),
      finalScopeType,
      finalPrimaryDocumentId,
      String(documentId),
      documentName,
      finalKind,
      Number(priority || 0),
      safeJSONStringify({
        ...metadata,
        supplementScope: "workspace",
        scopeType: finalScopeType,
        primaryDocumentId:
          finalPrimaryDocumentId === "__workspace__"
            ? null
            : finalPrimaryDocumentId,
        supplementKind: finalKind,
      })
    );

    const row = (
      await prisma.$queryRawUnsafe(
        `SELECT *, CAST("createdAt" AS TEXT) AS "createdAt",
          CAST("updatedAt" AS TEXT) AS "updatedAt"
        FROM "WorkspaceSupplement"
        WHERE "workspaceId" = ? AND "scopeType" = ?
          AND "primaryDocumentId" = ? AND "documentId" = ?
        LIMIT 1`,
        Number(workspaceId),
        finalScopeType,
        finalPrimaryDocumentId,
        String(documentId)
      )
    )?.[0];
    return { success: true, supplement: normalizeRow(row) };
  },

  async delete({ workspaceId, id }) {
    await ensureTable();
    const row = (
      await prisma.$queryRawUnsafe(
        `SELECT *, CAST("createdAt" AS TEXT) AS "createdAt",
          CAST("updatedAt" AS TEXT) AS "updatedAt"
        FROM "WorkspaceSupplement"
        WHERE "workspaceId" = ? AND "id" = ? LIMIT 1`,
        Number(workspaceId),
        Number(id)
      )
    )?.[0];
    if (!row) return { success: false, error: "supplement_not_found" };
    await prisma.$executeRawUnsafe(
      `DELETE FROM "WorkspaceSupplement" WHERE "workspaceId" = ? AND "id" = ?`,
      Number(workspaceId),
      Number(id)
    );
    return { success: true, supplement: normalizeRow(row) };
  },

  async deleteForDocument({ workspaceId, documentId }) {
    await ensureTable();
    if (!workspaceId || !documentId) return false;
    await prisma.$executeRawUnsafe(
      `DELETE FROM "WorkspaceSupplement"
      WHERE "workspaceId" = ? AND "documentId" = ?`,
      Number(workspaceId),
      String(documentId)
    );
    return true;
  },
};

module.exports = { WorkspaceSupplement };
