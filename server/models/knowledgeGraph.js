const crypto = require("crypto");
const prisma = require("../utils/prisma");
const { safeJsonParse } = require("../utils/http");
const { cachedVectorInformation, fileData } = require("../utils/files");

let tablesReady = false;

function safeJSONStringify(value, fallback = "[]") {
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function canonicalKey(value = "") {
  return String(aliasSearchValues(value)[0] || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function aliasSearchValues(value = "") {
  if (value === null || value === undefined) return [];
  if (typeof value === "object" && !Array.isArray(value)) {
    return [value.en, value.zh, value.name, value.label]
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }
  return [String(value || "").trim()].filter(Boolean);
}

function normalizeAliases(aliases = []) {
  const seen = new Set();
  const normalized = [];
  for (const alias of Array.isArray(aliases) ? aliases : []) {
    if (alias && typeof alias === "object" && !Array.isArray(alias)) {
      const item = {
        ...(alias.en ? { en: String(alias.en).trim() } : {}),
        ...(alias.zh ? { zh: String(alias.zh).trim() } : {}),
      };
      const key = `${canonicalKey(item.en)}::${canonicalKey(item.zh)}`;
      if ((!item.en && !item.zh) || seen.has(key)) continue;
      seen.add(key);
      normalized.push(item);
      continue;
    }
    const text = String(alias || "").trim();
    if (text === "[object Object]") continue;
    const key = canonicalKey(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    normalized.push(text);
  }
  return normalized.slice(0, 20);
}

function aliasMatches(aliases = [], key = "") {
  return (aliases || []).some((alias) =>
    aliasSearchValues(alias).some((value) => canonicalKey(value) === key)
  );
}

function aliasIncludes(aliases = [], key = "") {
  return (aliases || []).some((alias) =>
    aliasSearchValues(alias).some((value) => canonicalKey(value).includes(key))
  );
}

function paramsHash(value = {}) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function toSqliteDateTime(date) {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function toNode(row = null) {
  if (!row) return null;
  return {
    ...row,
    aliases: safeJsonParse(row.aliases, []),
    embedding: row.embedding ? safeJsonParse(row.embedding, null) : null,
  };
}

function toCache(row = null) {
  if (!row) return null;
  return {
    ...row,
    result: safeJsonParse(row.resultJson, null),
  };
}

function toRepairIssue(row = null) {
  if (!row) return null;
  return {
    ...row,
    rootConceptHit: !!row.rootConceptHit,
    metadata: safeJsonParse(row.metadataJson, {}),
  };
}

function toRepairRun(row = null) {
  if (!row) return null;
  return {
    ...row,
    budgetExhausted: !!row.budgetExhausted,
    metrics: safeJsonParse(row.metricsJson, {}),
  };
}

const REPAIR_ISSUE_SELECT = `"id", "workspaceId", "documentId", "chunkId",
  "issueType", "status", "priorityScore", "priorityReason", "rootConceptHit",
  "workspaceImportanceScore", "traversalUsageCount", "retryCount",
  CAST("nextRetryAt" AS TEXT) AS "nextRetryAt",
  CAST("cooldownUntil" AS TEXT) AS "cooldownUntil",
  "repairMethod", "repairConfidence", "lastError", "explainReason",
  "quarantineReason", "metadataJson",
  CAST("createdAt" AS TEXT) AS "createdAt",
  CAST("updatedAt" AS TEXT) AS "updatedAt"`;

const REPAIR_RUN_SELECT = `"id", "workspaceId", "trigger", "scanned",
  "repaired", "failed", "skipped", "budgetExhausted", "durationMs",
  "tokenBudgetUsed", "providerBudgetUsed", "successRate",
  "avgRepairLatencyMs", "providerFailureRate", "needsReembedCount",
  "quarantinedCount", "lowConfidenceRelationRatio", "relatedToRatio",
  "malformedExtractionRatio", "abnormalFanoutCount", "timeoutRate",
  "malformedJsonRate", "avgExtractionLatencyMs", "providerFailureTrend",
  "metricsJson", CAST("createdAt" AS TEXT) AS "createdAt"`;

function toNodeMetrics(row = null) {
  if (!row) return null;
  return {
    ...row,
    stale: !!row.stale,
    reasons: safeJsonParse(row.reasonsJson, {}),
    normalizedInputs: safeJsonParse(row.normalizedInputsJson, {}),
  };
}

function toMetricsRun(row = null) {
  if (!row) return null;
  return {
    ...row,
    errors: safeJsonParse(row.errorJson, []),
  };
}

function countFrom(rows) {
  return Number(rows?.[0]?.count || 0);
}

async function ensureTables() {
  if (tablesReady) return;
  const statements = [
    `CREATE TABLE IF NOT EXISTS "KnowledgeNode" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "workspaceId" INTEGER NOT NULL,
      "canonicalName" TEXT NOT NULL,
      "canonicalKey" TEXT NOT NULL,
      "aliases" TEXT NOT NULL DEFAULT '[]',
      "displayNameZh" TEXT,
      "displayNameEn" TEXT,
      "entityType" TEXT NOT NULL DEFAULT 'concept',
      "summary" TEXT,
      "globalImportanceScore" REAL NOT NULL DEFAULT 0,
      "workspaceImportanceScore" REAL NOT NULL DEFAULT 0,
      "recentImportanceScore" REAL NOT NULL DEFAULT 0,
      "usageCount" INTEGER NOT NULL DEFAULT 0,
      "recentUsageCount" INTEGER NOT NULL DEFAULT 0,
      "lastReferencedAt" DATETIME,
      "embedding" TEXT,
      "embeddingModel" TEXT,
      "embeddingVersion" TEXT,
      "mergeLogicVersion" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeNode_workspaceId_canonicalKey_key" ON "KnowledgeNode"("workspaceId", "canonicalKey")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeNode_workspaceId_entityType_idx" ON "KnowledgeNode"("workspaceId", "entityType")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeNode_workspaceId_canonicalKey_idx" ON "KnowledgeNode"("workspaceId", "canonicalKey")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeNode_workspaceId_globalImportanceScore_idx" ON "KnowledgeNode"("workspaceId", "globalImportanceScore")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeNode_workspaceId_workspaceImportanceScore_idx" ON "KnowledgeNode"("workspaceId", "workspaceImportanceScore")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeNode_workspaceId_recentImportanceScore_idx" ON "KnowledgeNode"("workspaceId", "recentImportanceScore")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeNode_workspaceId_lastReferencedAt_idx" ON "KnowledgeNode"("workspaceId", "lastReferencedAt")`,
    `CREATE TABLE IF NOT EXISTS "KnowledgeEdge" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "workspaceId" INTEGER NOT NULL,
      "sourceNodeId" INTEGER NOT NULL,
      "targetNodeId" INTEGER NOT NULL,
      "relationType" TEXT NOT NULL,
      "relationLabel" TEXT,
      "relationLabelZh" TEXT,
      "relationLabelEn" TEXT,
      "confidence" REAL NOT NULL DEFAULT 0,
      "weight" REAL NOT NULL DEFAULT 1,
      "usageCount" INTEGER NOT NULL DEFAULT 0,
      "lastReferencedAt" DATETIME,
      "extractionPromptVersion" TEXT NOT NULL,
      "mergeLogicVersion" TEXT NOT NULL,
      "relationOntologyVersion" TEXT NOT NULL,
      "graphVersion" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeEdge_workspaceId_sourceNodeId_targetNodeId_relationType_key" ON "KnowledgeEdge"("workspaceId", "sourceNodeId", "targetNodeId", "relationType")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeEdge_workspaceId_sourceNodeId_idx" ON "KnowledgeEdge"("workspaceId", "sourceNodeId")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeEdge_workspaceId_targetNodeId_idx" ON "KnowledgeEdge"("workspaceId", "targetNodeId")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeEdge_workspaceId_relationType_idx" ON "KnowledgeEdge"("workspaceId", "relationType")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeEdge_workspaceId_confidence_idx" ON "KnowledgeEdge"("workspaceId", "confidence")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeEdge_workspaceId_weight_idx" ON "KnowledgeEdge"("workspaceId", "weight")`,
    `CREATE TABLE IF NOT EXISTS "EdgeEvidence" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "workspaceId" INTEGER NOT NULL,
      "edgeId" INTEGER NOT NULL,
      "documentId" TEXT NOT NULL,
      "chunkId" TEXT NOT NULL,
      "snippet" TEXT,
      "confidence" REAL NOT NULL DEFAULT 0,
      "extractionJobId" INTEGER,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "EdgeEvidence_edgeId_chunkId_key" ON "EdgeEvidence"("edgeId", "chunkId")`,
    `CREATE INDEX IF NOT EXISTS "EdgeEvidence_workspaceId_edgeId_idx" ON "EdgeEvidence"("workspaceId", "edgeId")`,
    `CREATE INDEX IF NOT EXISTS "EdgeEvidence_workspaceId_documentId_idx" ON "EdgeEvidence"("workspaceId", "documentId")`,
    `CREATE INDEX IF NOT EXISTS "EdgeEvidence_workspaceId_chunkId_idx" ON "EdgeEvidence"("workspaceId", "chunkId")`,
    `CREATE TABLE IF NOT EXISTS "ConceptChunkMap" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "workspaceId" INTEGER NOT NULL,
      "nodeId" INTEGER NOT NULL,
      "documentId" TEXT NOT NULL,
      "chunkId" TEXT NOT NULL,
      "relevanceScore" REAL NOT NULL DEFAULT 0,
      "mentionCount" INTEGER NOT NULL DEFAULT 1,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "ConceptChunkMap_workspaceId_nodeId_chunkId_key" ON "ConceptChunkMap"("workspaceId", "nodeId", "chunkId")`,
    `CREATE INDEX IF NOT EXISTS "ConceptChunkMap_workspaceId_nodeId_idx" ON "ConceptChunkMap"("workspaceId", "nodeId")`,
    `CREATE INDEX IF NOT EXISTS "ConceptChunkMap_workspaceId_chunkId_idx" ON "ConceptChunkMap"("workspaceId", "chunkId")`,
    `CREATE INDEX IF NOT EXISTS "ConceptChunkMap_workspaceId_documentId_idx" ON "ConceptChunkMap"("workspaceId", "documentId")`,
    `CREATE TABLE IF NOT EXISTS "GraphExtractionJob" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "workspaceId" INTEGER NOT NULL,
      "chunkId" TEXT NOT NULL,
      "documentId" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "graphVersion" TEXT NOT NULL,
      "extractionPromptVersion" TEXT NOT NULL,
      "promptDomain" TEXT NOT NULL,
      "mergeLogicVersion" TEXT NOT NULL,
      "relationOntologyVersion" TEXT NOT NULL,
      "extractedAt" DATETIME,
      "errorMessage" TEXT,
      "retryCount" INTEGER NOT NULL DEFAULT 0,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "GraphExtractionJob_workspaceId_chunkId_key" ON "GraphExtractionJob"("workspaceId", "chunkId")`,
    `CREATE INDEX IF NOT EXISTS "GraphExtractionJob_status_idx" ON "GraphExtractionJob"("status")`,
    `CREATE INDEX IF NOT EXISTS "GraphExtractionJob_workspaceId_chunkId_idx" ON "GraphExtractionJob"("workspaceId", "chunkId")`,
    `CREATE INDEX IF NOT EXISTS "GraphExtractionJob_workspaceId_documentId_idx" ON "GraphExtractionJob"("workspaceId", "documentId")`,
    `CREATE TABLE IF NOT EXISTS "GraphRetrievalCache" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "workspaceId" INTEGER NOT NULL,
      "conceptKey" TEXT NOT NULL,
      "paramsHash" TEXT NOT NULL,
      "resultJson" TEXT NOT NULL,
      "hitCount" INTEGER NOT NULL DEFAULT 0,
      "expiresAt" DATETIME NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "GraphRetrievalCache_workspaceId_conceptKey_paramsHash_key" ON "GraphRetrievalCache"("workspaceId", "conceptKey", "paramsHash")`,
    `CREATE INDEX IF NOT EXISTS "GraphRetrievalCache_workspaceId_conceptKey_idx" ON "GraphRetrievalCache"("workspaceId", "conceptKey")`,
    `CREATE INDEX IF NOT EXISTS "GraphRetrievalCache_workspaceId_expiresAt_idx" ON "GraphRetrievalCache"("workspaceId", "expiresAt")`,
    `CREATE TABLE IF NOT EXISTS "GraphLabelTranslationCache" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "workspaceId" INTEGER NOT NULL,
      "cacheKey" TEXT NOT NULL,
      "sourceText" TEXT NOT NULL,
      "sourceType" TEXT NOT NULL DEFAULT 'node',
      "displayNameZh" TEXT,
      "displayNameEn" TEXT,
      "aliasesJson" TEXT NOT NULL DEFAULT '[]',
      "model" TEXT,
      "promptVersion" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "GraphLabelTranslationCache_workspaceId_cacheKey_key" ON "GraphLabelTranslationCache"("workspaceId", "cacheKey")`,
    `CREATE TABLE IF NOT EXISTS "KnowledgeGraphRepairIssue" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "workspaceId" INTEGER NOT NULL,
      "documentId" TEXT NOT NULL DEFAULT '',
      "chunkId" TEXT NOT NULL DEFAULT '',
      "issueType" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'open',
      "priorityScore" REAL NOT NULL DEFAULT 0,
      "priorityReason" TEXT,
      "rootConceptHit" BOOLEAN NOT NULL DEFAULT false,
      "workspaceImportanceScore" REAL NOT NULL DEFAULT 0,
      "traversalUsageCount" INTEGER NOT NULL DEFAULT 0,
      "retryCount" INTEGER NOT NULL DEFAULT 0,
      "nextRetryAt" DATETIME,
      "cooldownUntil" DATETIME,
      "repairMethod" TEXT,
      "repairConfidence" TEXT,
      "lastError" TEXT,
      "explainReason" TEXT,
      "quarantineReason" TEXT,
      "metadataJson" TEXT NOT NULL DEFAULT '{}',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeGraphRepairIssue_workspaceId_issueType_documentId_chunkId_key" ON "KnowledgeGraphRepairIssue"("workspaceId", "issueType", "documentId", "chunkId")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeGraphRepairIssue_workspaceId_status_idx" ON "KnowledgeGraphRepairIssue"("workspaceId", "status")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeGraphRepairIssue_workspaceId_priorityScore_idx" ON "KnowledgeGraphRepairIssue"("workspaceId", "priorityScore")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeGraphRepairIssue_workspaceId_nextRetryAt_idx" ON "KnowledgeGraphRepairIssue"("workspaceId", "nextRetryAt")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeGraphRepairIssue_workspaceId_cooldownUntil_idx" ON "KnowledgeGraphRepairIssue"("workspaceId", "cooldownUntil")`,
    `CREATE TABLE IF NOT EXISTS "KnowledgeGraphEvidenceUsage" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "workspaceId" INTEGER NOT NULL,
      "targetType" TEXT NOT NULL,
      "targetId" TEXT NOT NULL,
      "action" TEXT NOT NULL,
      "count" INTEGER NOT NULL DEFAULT 1,
      "lastUsedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeGraphEvidenceUsage_workspaceId_targetType_targetId_action_key" ON "KnowledgeGraphEvidenceUsage"("workspaceId", "targetType", "targetId", "action")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeGraphEvidenceUsage_workspaceId_targetType_targetId_idx" ON "KnowledgeGraphEvidenceUsage"("workspaceId", "targetType", "targetId")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeGraphEvidenceUsage_workspaceId_action_idx" ON "KnowledgeGraphEvidenceUsage"("workspaceId", "action")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeGraphEvidenceUsage_workspaceId_lastUsedAt_idx" ON "KnowledgeGraphEvidenceUsage"("workspaceId", "lastUsedAt")`,
    `CREATE TABLE IF NOT EXISTS "KnowledgeNodeMetrics" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "workspaceId" INTEGER NOT NULL,
      "nodeId" INTEGER NOT NULL,
      "evidenceStrength" INTEGER NOT NULL DEFAULT 0,
      "bridgeValue" INTEGER NOT NULL DEFAULT 0,
      "knowledgeConnectivity" INTEGER NOT NULL DEFAULT 0,
      "traversalImportance" INTEGER NOT NULL DEFAULT 0,
      "crossDocumentPresence" INTEGER NOT NULL DEFAULT 0,
      "freshness" INTEGER NOT NULL DEFAULT 0,
      "relationDiversity" INTEGER NOT NULL DEFAULT 0,
      "sourceAuthority" INTEGER NOT NULL DEFAULT 0,
      "stability" INTEGER NOT NULL DEFAULT 0,
      "conflictSafety" INTEGER NOT NULL DEFAULT 0,
      "reasonsJson" TEXT NOT NULL DEFAULT '{}',
      "normalizedInputsJson" TEXT NOT NULL DEFAULT '{}',
      "formulaVersion" TEXT NOT NULL DEFAULT 'metrics-v1',
      "stale" BOOLEAN NOT NULL DEFAULT true,
      "warning" TEXT,
      "lastError" TEXT,
      "lockedAt" DATETIME,
      "lockedBy" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeNodeMetrics_workspaceId_nodeId_key" ON "KnowledgeNodeMetrics"("workspaceId", "nodeId")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetrics_workspaceId_idx" ON "KnowledgeNodeMetrics"("workspaceId")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetrics_nodeId_idx" ON "KnowledgeNodeMetrics"("nodeId")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetrics_formulaVersion_idx" ON "KnowledgeNodeMetrics"("formulaVersion")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetrics_stale_idx" ON "KnowledgeNodeMetrics"("stale")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetrics_lockedAt_idx" ON "KnowledgeNodeMetrics"("lockedAt")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetrics_updatedAt_idx" ON "KnowledgeNodeMetrics"("updatedAt")`,
    `CREATE TABLE IF NOT EXISTS "KnowledgeNodeMetricsSnapshot" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "workspaceId" INTEGER NOT NULL,
      "nodeId" INTEGER NOT NULL,
      "formulaVersion" TEXT NOT NULL,
      "scoresJson" TEXT NOT NULL,
      "normalizedInputsJson" TEXT NOT NULL DEFAULT '{}',
      "snapshotPeriod" TEXT NOT NULL DEFAULT 'daily',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetricsSnapshot_workspaceId_nodeId_idx" ON "KnowledgeNodeMetricsSnapshot"("workspaceId", "nodeId")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetricsSnapshot_formulaVersion_idx" ON "KnowledgeNodeMetricsSnapshot"("formulaVersion")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetricsSnapshot_snapshotPeriod_idx" ON "KnowledgeNodeMetricsSnapshot"("snapshotPeriod")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetricsSnapshot_createdAt_idx" ON "KnowledgeNodeMetricsSnapshot"("createdAt")`,
    `CREATE TABLE IF NOT EXISTS "KnowledgeNodeMetricsRecomputeRun" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "workspaceId" INTEGER,
      "trigger" TEXT NOT NULL DEFAULT 'worker',
      "formulaVersion" TEXT NOT NULL DEFAULT 'metrics-v1',
      "batchSize" INTEGER NOT NULL DEFAULT 0,
      "processed" INTEGER NOT NULL DEFAULT 0,
      "succeeded" INTEGER NOT NULL DEFAULT 0,
      "failed" INTEGER NOT NULL DEFAULT 0,
      "skipped" INTEGER NOT NULL DEFAULT 0,
      "durationMs" INTEGER NOT NULL DEFAULT 0,
      "lockedCount" INTEGER NOT NULL DEFAULT 0,
      "errorJson" TEXT NOT NULL DEFAULT '[]',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetricsRecomputeRun_workspaceId_idx" ON "KnowledgeNodeMetricsRecomputeRun"("workspaceId")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetricsRecomputeRun_trigger_idx" ON "KnowledgeNodeMetricsRecomputeRun"("trigger")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetricsRecomputeRun_formulaVersion_idx" ON "KnowledgeNodeMetricsRecomputeRun"("formulaVersion")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeNodeMetricsRecomputeRun_createdAt_idx" ON "KnowledgeNodeMetricsRecomputeRun"("createdAt")`,
    `CREATE TABLE IF NOT EXISTS "KnowledgeGraphRepairRun" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "workspaceId" INTEGER NOT NULL,
      "trigger" TEXT NOT NULL DEFAULT 'auto',
      "scanned" INTEGER NOT NULL DEFAULT 0,
      "repaired" INTEGER NOT NULL DEFAULT 0,
      "failed" INTEGER NOT NULL DEFAULT 0,
      "skipped" INTEGER NOT NULL DEFAULT 0,
      "budgetExhausted" BOOLEAN NOT NULL DEFAULT false,
      "durationMs" INTEGER NOT NULL DEFAULT 0,
      "tokenBudgetUsed" INTEGER NOT NULL DEFAULT 0,
      "providerBudgetUsed" INTEGER NOT NULL DEFAULT 0,
      "successRate" REAL NOT NULL DEFAULT 0,
      "avgRepairLatencyMs" REAL NOT NULL DEFAULT 0,
      "providerFailureRate" REAL NOT NULL DEFAULT 0,
      "needsReembedCount" INTEGER NOT NULL DEFAULT 0,
      "quarantinedCount" INTEGER NOT NULL DEFAULT 0,
      "lowConfidenceRelationRatio" REAL NOT NULL DEFAULT 0,
      "relatedToRatio" REAL NOT NULL DEFAULT 0,
      "malformedExtractionRatio" REAL NOT NULL DEFAULT 0,
      "abnormalFanoutCount" INTEGER NOT NULL DEFAULT 0,
      "timeoutRate" REAL NOT NULL DEFAULT 0,
      "malformedJsonRate" REAL NOT NULL DEFAULT 0,
      "avgExtractionLatencyMs" REAL NOT NULL DEFAULT 0,
      "providerFailureTrend" REAL NOT NULL DEFAULT 0,
      "metricsJson" TEXT NOT NULL DEFAULT '{}',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeGraphRepairRun_workspaceId_createdAt_idx" ON "KnowledgeGraphRepairRun"("workspaceId", "createdAt")`,
    `CREATE INDEX IF NOT EXISTS "KnowledgeGraphRepairRun_workspaceId_trigger_idx" ON "KnowledgeGraphRepairRun"("workspaceId", "trigger")`,
  ];
  for (const statement of statements) {
    await prisma.$executeRawUnsafe(statement);
  }
  await ensureColumn("KnowledgeNode", "displayNameZh", "TEXT");
  await ensureColumn("KnowledgeNode", "displayNameEn", "TEXT");
  await ensureColumn("KnowledgeEdge", "relationLabelZh", "TEXT");
  await ensureColumn("KnowledgeEdge", "relationLabelEn", "TEXT");
  tablesReady = true;
}

async function ensureColumn(table, column, definition) {
  const columns = await prisma.$queryRawUnsafe(`PRAGMA table_info("${table}")`);
  if (columns.some((item) => item.name === column)) return;
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`
  );
}

async function resolveLegacyVectorCacheRepairIssues(workspaceId) {
  await prisma.$executeRawUnsafe(
    `UPDATE "KnowledgeGraphRepairIssue"
    SET "status" = 'repaired',
      "repairMethod" = COALESCE("repairMethod", 'source_text_fallback_accepted'),
      "repairConfidence" = COALESCE("repairConfidence", 'medium'),
      "explainReason" = '历史 vector-cache 遗留状态已清理；该文档可通过源文档文本参与 KG 覆盖，不再计入健康告警。',
      "lastError" = NULL,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "workspaceId" = ?
      AND "issueType" = 'missing_vector_cache'
      AND "status" IN ('open', 'needs_reembed', 'quarantined')
      AND "metadataJson" LIKE '%"hasSourceText":true%'`,
    Number(workspaceId)
  );
}

const KnowledgeGraph = {
  statuses: {
    pending: "pending",
    processing: "processing",
    completed: "completed",
    failed: "failed",
  },

  canonicalKey,
  paramsHash,
  ensureTables,

  async findNodeByNameOrAlias({ workspaceId, name, ensureSchema = true }) {
    if (ensureSchema) await ensureTables();
    const key = canonicalKey(name);
    const direct = (
      await prisma.$queryRawUnsafe(
        `SELECT * FROM "KnowledgeNode"
        WHERE "workspaceId" = ? AND "canonicalKey" = ?
        LIMIT 1`,
        Number(workspaceId),
        key
      )
    )?.[0];
    if (direct) return toNode(direct);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT * FROM "KnowledgeNode" WHERE "workspaceId" = ?`,
      Number(workspaceId)
    );
    return (
      rows
        .map(toNode)
        .find((node) =>
          aliasMatches(
            [node.displayNameZh, node.displayNameEn, ...(node.aliases || [])],
            key
          )
        ) || null
    );
  },

  async upsertNode({
    workspaceId,
    name,
    entityType = "concept",
    summary = null,
    aliases = [],
    mergeLogicVersion,
    embedding = null,
    embeddingModel = null,
    embeddingVersion = null,
  }) {
    await ensureTables();
    const cleanName = String(name || "").trim();
    if (!workspaceId || !cleanName) return null;

    const existing = await this.findNodeByNameOrAlias({
      workspaceId,
      name: cleanName,
    });
    const normalizedAliases = normalizeAliases([
      cleanName,
      ...(existing?.aliases || []),
      ...(Array.isArray(aliases) ? aliases : []),
    ]);

    if (existing) {
      await prisma.$executeRawUnsafe(
        `UPDATE "KnowledgeNode"
        SET "aliases" = ?, "entityType" = ?, "summary" = COALESCE(?, "summary"),
          "embedding" = COALESCE(?, "embedding"),
          "embeddingModel" = COALESCE(?, "embeddingModel"),
          "embeddingVersion" = COALESCE(?, "embeddingVersion"),
          "mergeLogicVersion" = ?, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ?`,
        safeJSONStringify(normalizedAliases),
        entityType || existing.entityType || "concept",
        summary,
        embedding ? safeJSONStringify(embedding) : null,
        embeddingModel,
        embeddingVersion,
        mergeLogicVersion,
        existing.id
      );
      return await this.getNode(existing.id);
    }

    await prisma.$executeRawUnsafe(
      `INSERT INTO "KnowledgeNode" (
        "workspaceId", "canonicalName", "canonicalKey", "aliases", "entityType",
        "summary", "embedding", "embeddingModel", "embeddingVersion",
        "mergeLogicVersion"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      Number(workspaceId),
      cleanName,
      canonicalKey(cleanName),
      safeJSONStringify(normalizedAliases),
      entityType || "concept",
      summary,
      embedding ? safeJSONStringify(embedding) : null,
      embeddingModel,
      embeddingVersion,
      mergeLogicVersion
    );
    return await this.findNodeByNameOrAlias({ workspaceId, name: cleanName });
  },

  async getNode(id) {
    await ensureTables();
    const row = (
      await prisma.$queryRawUnsafe(
        `SELECT * FROM "KnowledgeNode" WHERE "id" = ? LIMIT 1`,
        Number(id)
      )
    )?.[0];
    return toNode(row);
  },

  async updateNodeDisplayLabels({
    id,
    displayNameZh = null,
    displayNameEn = null,
    aliases = null,
  }) {
    await ensureTables();
    if (!id) return null;
    const current = await this.getNode(id);
    if (!current) return null;
    const nextAliases = aliases
      ? normalizeAliases([...(current.aliases || []), ...aliases])
      : current.aliases || [];
    await prisma.$executeRawUnsafe(
      `UPDATE "KnowledgeNode"
      SET "displayNameZh" = COALESCE(?, "displayNameZh"),
        "displayNameEn" = COALESCE(?, "displayNameEn"),
        "aliases" = ?,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ?`,
      displayNameZh,
      displayNameEn,
      safeJSONStringify(nextAliases),
      Number(id)
    );
    return await this.getNode(id);
  },

  async updateNodeChineseFields({
    id,
    displayNameZh = null,
    summary = null,
    aliases = null,
  }) {
    await ensureTables();
    if (!id) return null;
    const current = await this.getNode(id);
    if (!current) return null;
    const nextAliases = aliases
      ? normalizeAliases([...(current.aliases || []), ...aliases])
      : current.aliases || [];
    await prisma.$executeRawUnsafe(
      `UPDATE "KnowledgeNode"
      SET "displayNameZh" = COALESCE(?, "displayNameZh"),
        "summary" = COALESCE(?, "summary"),
        "aliases" = ?,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ?`,
      displayNameZh,
      summary,
      safeJSONStringify(nextAliases),
      Number(id)
    );
    return await this.getNode(id);
  },

  async findLabelTranslationCache({ workspaceId, cacheKey }) {
    await ensureTables();
    const row = (
      await prisma.$queryRawUnsafe(
        `SELECT * FROM "GraphLabelTranslationCache"
        WHERE "workspaceId" = ? AND "cacheKey" = ?
        LIMIT 1`,
        Number(workspaceId),
        String(cacheKey)
      )
    )?.[0];
    if (!row) return null;
    return {
      ...row,
      aliases: safeJsonParse(row.aliasesJson, []),
    };
  },

  async setLabelTranslationCache({
    workspaceId,
    cacheKey,
    sourceText,
    sourceType = "node",
    displayNameZh = null,
    displayNameEn = null,
    aliases = [],
    model = null,
    promptVersion,
  }) {
    await ensureTables();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "GraphLabelTranslationCache" (
        "workspaceId", "cacheKey", "sourceText", "sourceType",
        "displayNameZh", "displayNameEn", "aliasesJson", "model",
        "promptVersion"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT("workspaceId", "cacheKey") DO UPDATE SET
        "displayNameZh" = COALESCE(excluded."displayNameZh", "displayNameZh"),
        "displayNameEn" = COALESCE(excluded."displayNameEn", "displayNameEn"),
        "aliasesJson" = excluded."aliasesJson",
        "model" = excluded."model",
        "promptVersion" = excluded."promptVersion",
        "updatedAt" = CURRENT_TIMESTAMP`,
      Number(workspaceId),
      String(cacheKey),
      String(sourceText || ""),
      sourceType,
      displayNameZh,
      displayNameEn,
      safeJSONStringify(normalizeAliases(aliases)),
      model,
      promptVersion
    );
    return await this.findLabelTranslationCache({ workspaceId, cacheKey });
  },

  async upsertConceptChunk({
    workspaceId,
    nodeId,
    documentId,
    chunkId,
    relevanceScore = 0.5,
    mentionCount = 1,
  }) {
    await ensureTables();
    if (!workspaceId || !nodeId || !documentId || !chunkId) return null;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "ConceptChunkMap" (
        "workspaceId", "nodeId", "documentId", "chunkId", "relevanceScore", "mentionCount"
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT("workspaceId", "nodeId", "chunkId") DO UPDATE SET
        "relevanceScore" = MAX("relevanceScore", excluded."relevanceScore"),
        "mentionCount" = "mentionCount" + excluded."mentionCount",
        "updatedAt" = CURRENT_TIMESTAMP`,
      Number(workspaceId),
      Number(nodeId),
      String(documentId),
      String(chunkId),
      Number(relevanceScore || 0),
      Number(mentionCount || 1)
    );
    await this.markNodeMetricsStale({
      workspaceId,
      nodeIds: [nodeId],
      reason: "concept_chunk_map_updated",
    });
  },

  async upsertEdgeWithEvidence({
    workspaceId,
    sourceNodeId,
    targetNodeId,
    relationType,
    relationLabel = null,
    relationLabelZh = null,
    relationLabelEn = null,
    confidence = 0.5,
    documentId,
    chunkId,
    snippet = null,
    extractionJobId = null,
    extractionPromptVersion,
    mergeLogicVersion,
    relationOntologyVersion,
    graphVersion,
  }) {
    await ensureTables();
    if (
      !workspaceId ||
      !sourceNodeId ||
      !targetNodeId ||
      Number(sourceNodeId) === Number(targetNodeId) ||
      !relationType
    )
      return null;

    await prisma.$executeRawUnsafe(
      `INSERT INTO "KnowledgeEdge" (
        "workspaceId", "sourceNodeId", "targetNodeId", "relationType",
        "relationLabel", "relationLabelZh", "relationLabelEn", "confidence",
        "weight", "extractionPromptVersion",
        "mergeLogicVersion", "relationOntologyVersion", "graphVersion"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT("workspaceId", "sourceNodeId", "targetNodeId", "relationType")
      DO UPDATE SET
        "relationLabel" = COALESCE(excluded."relationLabel", "relationLabel"),
        "relationLabelZh" = COALESCE(excluded."relationLabelZh", "relationLabelZh"),
        "relationLabelEn" = COALESCE(excluded."relationLabelEn", "relationLabelEn"),
        "confidence" = MAX("confidence", excluded."confidence"),
        "weight" = "weight" + 1,
        "updatedAt" = CURRENT_TIMESTAMP`,
      Number(workspaceId),
      Number(sourceNodeId),
      Number(targetNodeId),
      relationType,
      relationLabel,
      relationLabelZh,
      relationLabelEn,
      Number(confidence || 0),
      extractionPromptVersion,
      mergeLogicVersion,
      relationOntologyVersion,
      graphVersion
    );

    const edge = (
      await prisma.$queryRawUnsafe(
        `SELECT * FROM "KnowledgeEdge"
        WHERE "workspaceId" = ? AND "sourceNodeId" = ? AND "targetNodeId" = ?
          AND "relationType" = ?
        LIMIT 1`,
        Number(workspaceId),
        Number(sourceNodeId),
        Number(targetNodeId),
        relationType
      )
    )?.[0];
    if (!edge) return null;

    if (documentId && chunkId) {
      await prisma.$executeRawUnsafe(
        `INSERT OR IGNORE INTO "EdgeEvidence" (
          "workspaceId", "edgeId", "documentId", "chunkId", "snippet",
          "confidence", "extractionJobId"
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        Number(workspaceId),
        Number(edge.id),
        String(documentId),
        String(chunkId),
        snippet ? String(snippet).slice(0, 1_000) : null,
        Number(confidence || 0),
        extractionJobId ? Number(extractionJobId) : null
      );
    }

    await this.markNodeMetricsStale({
      workspaceId,
      nodeIds: [sourceNodeId, targetNodeId],
      reason: "edge_or_evidence_updated",
    });
    await this.invalidateCache(workspaceId);
    return edge;
  },

  async scheduleJob({
    workspaceId,
    documentId,
    chunkId,
    promptDomain,
    graphVersion,
    extractionPromptVersion,
    mergeLogicVersion,
    relationOntologyVersion,
  }) {
    await ensureTables();
    if (!workspaceId || !documentId || !chunkId) return null;
    const existing = (
      await prisma.$queryRawUnsafe(
        `SELECT * FROM "GraphExtractionJob"
        WHERE "workspaceId" = ? AND "chunkId" = ?
        LIMIT 1`,
        Number(workspaceId),
        String(chunkId)
      )
    )?.[0];
    if (existing) return { ...existing, created: false };

    await prisma.$executeRawUnsafe(
      `INSERT INTO "GraphExtractionJob" (
        "workspaceId", "chunkId", "documentId", "status", "graphVersion",
        "extractionPromptVersion", "promptDomain", "mergeLogicVersion",
        "relationOntologyVersion"
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      Number(workspaceId),
      String(chunkId),
      String(documentId),
      graphVersion,
      extractionPromptVersion,
      promptDomain,
      mergeLogicVersion,
      relationOntologyVersion
    );
    const rows = await prisma.$queryRawUnsafe(
      `SELECT * FROM "GraphExtractionJob"
      WHERE "workspaceId" = ? AND "chunkId" = ?
      LIMIT 1`,
      Number(workspaceId),
      String(chunkId)
    );
    return rows?.[0] ? { ...rows[0], created: true } : null;
  },

  async pendingJobs({ workspaceId = null, limit = 10, retryFailed = false }) {
    await ensureTables();
    const statuses = retryFailed ? ["pending", "failed"] : ["pending"];
    const sqlWorkspace = workspaceId ? `AND "workspaceId" = ?` : "";
    return await prisma.$queryRawUnsafe(
      `SELECT * FROM "GraphExtractionJob"
      WHERE "status" IN (${statuses.map(() => "?").join(",")}) ${sqlWorkspace}
        AND NOT EXISTS (
          SELECT 1 FROM "KnowledgeGraphRepairIssue" issue
          WHERE issue."workspaceId" = "GraphExtractionJob"."workspaceId"
            AND issue."chunkId" = "GraphExtractionJob"."chunkId"
            AND issue."status" = 'quarantined'
        )
      ORDER BY "createdAt" ASC
      LIMIT ?`,
      ...statuses,
      ...(workspaceId ? [Number(workspaceId)] : []),
      Number(limit)
    );
  },

  async markJobProcessing(id) {
    await ensureTables();
    await prisma.$executeRawUnsafe(
      `UPDATE "GraphExtractionJob"
      SET "status" = 'processing', "errorMessage" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ?`,
      Number(id)
    );
  },

  async markJobCompleted(id) {
    await ensureTables();
    await prisma.$executeRawUnsafe(
      `UPDATE "GraphExtractionJob"
      SET "status" = 'completed', "extractedAt" = CURRENT_TIMESTAMP,
        "errorMessage" = NULL, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ?`,
      Number(id)
    );
  },

  async markJobFailed(id, error) {
    await ensureTables();
    await prisma.$executeRawUnsafe(
      `UPDATE "GraphExtractionJob"
      SET "status" = 'failed', "retryCount" = "retryCount" + 1,
        "errorMessage" = ?, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ?`,
      String(error?.message || error || "Unknown graph extraction error"),
      Number(id)
    );
  },

  async resetJobToPending(id, reason = null) {
    await ensureTables();
    await prisma.$executeRawUnsafe(
      `UPDATE "GraphExtractionJob"
      SET "status" = 'pending', "errorMessage" = ?,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ?`,
      reason,
      Number(id)
    );
  },

  async resetStaleProcessingJobs({
    workspaceId = null,
    staleMinutes = 15,
    reason = "auto_reset_stale_processing_job",
  } = {}) {
    await ensureTables();
    const workspaceClause = workspaceId ? `AND "workspaceId" = ?` : "";
    await prisma.$executeRawUnsafe(
      `UPDATE "GraphExtractionJob"
      SET "status" = 'pending', "errorMessage" = ?,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "status" = 'processing'
        AND "updatedAt" <= datetime('now', ?)
        ${workspaceClause}`,
      reason,
      `-${Math.max(1, Number(staleMinutes || 15))} minutes`,
      ...(workspaceId ? [Number(workspaceId)] : [])
    );
  },

  async graphStats(workspaceId, { ensureSchema = true } = {}) {
    if (ensureSchema) await ensureTables();
    const [
      nodes,
      edges,
      evidence,
      jobs,
      completedJobs,
      failedJobs,
      pendingJobs,
      processingJobs,
      graphCoveredDocuments,
      vectorDocuments,
      vectorRows,
      graphProcessedDocuments,
      noGraphOutputDocuments,
      workspaceDocuments,
      vectorDocumentRows,
    ] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*) AS count FROM "KnowledgeNode" WHERE "workspaceId" = ?`,
        Number(workspaceId)
      ),
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*) AS count FROM "KnowledgeEdge" WHERE "workspaceId" = ?`,
        Number(workspaceId)
      ),
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*) AS count FROM "EdgeEvidence" WHERE "workspaceId" = ?`,
        Number(workspaceId)
      ),
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*) AS count FROM "GraphExtractionJob" WHERE "workspaceId" = ?`,
        Number(workspaceId)
      ),
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*) AS count FROM "GraphExtractionJob" WHERE "workspaceId" = ? AND "status" = 'completed'`,
        Number(workspaceId)
      ),
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*) AS count FROM "GraphExtractionJob" WHERE "workspaceId" = ? AND "status" = 'failed'`,
        Number(workspaceId)
      ),
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*) AS count FROM "GraphExtractionJob" WHERE "workspaceId" = ? AND "status" = 'pending'`,
        Number(workspaceId)
      ),
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*) AS count FROM "GraphExtractionJob" WHERE "workspaceId" = ? AND "status" = 'processing'`,
        Number(workspaceId)
      ),
      prisma.$queryRawUnsafe(
        `SELECT COUNT(DISTINCT "documentId") AS count FROM "ConceptChunkMap" WHERE "workspaceId" = ?`,
        Number(workspaceId)
      ),
      prisma.$queryRawUnsafe(
        `SELECT COUNT(DISTINCT "documentId") AS count
        FROM "GraphExtractionJob"
        WHERE "workspaceId" = ?`,
        Number(workspaceId)
      ),
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*) AS count
        FROM "GraphExtractionJob"
        WHERE "workspaceId" = ?`,
        Number(workspaceId)
      ),
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*) AS count FROM (
          SELECT j."documentId"
          FROM "GraphExtractionJob" j
          WHERE j."workspaceId" = ?
          GROUP BY j."documentId"
          HAVING COUNT(*) > 0
            AND COUNT(*) = SUM(CASE WHEN j."status" IN ('completed', 'failed') THEN 1 ELSE 0 END)
        )`,
        Number(workspaceId)
      ),
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*) AS count FROM (
          SELECT j."documentId"
          FROM "GraphExtractionJob" j
          WHERE j."workspaceId" = ?
          GROUP BY j."documentId"
          HAVING COUNT(*) > 0
            AND COUNT(*) = SUM(CASE WHEN j."status" = 'completed' THEN 1 ELSE 0 END)
            AND NOT EXISTS (
              SELECT 1 FROM "ConceptChunkMap" c
              WHERE c."workspaceId" = ? AND c."documentId" = j."documentId"
            )
            AND NOT EXISTS (
              SELECT 1 FROM "EdgeEvidence" ev
              WHERE ev."workspaceId" = ? AND ev."documentId" = j."documentId"
            )
        )`,
        Number(workspaceId),
        Number(workspaceId),
        Number(workspaceId)
      ),
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*) AS count FROM "workspace_documents" WHERE "workspaceId" = ? AND "embeddingStatus" = 'completed'`,
        Number(workspaceId)
      ),
      prisma.$queryRawUnsafe(
        `SELECT d."docId", d."docpath", COUNT(j."chunkId") AS "vectorRows"
        FROM "workspace_documents" d
        LEFT JOIN "GraphExtractionJob" j
          ON j."workspaceId" = d."workspaceId" AND j."documentId" = d."docId"
        WHERE d."workspaceId" = ?
        GROUP BY d."docId", d."docpath"`,
        Number(workspaceId)
      ),
    ]);
    const vectorDocumentCacheStatus = await Promise.all(
      vectorDocumentRows.map(async (document) => {
        const hasCache = await cachedVectorInformation(document.docpath, true);
        const source = hasCache
          ? null
          : await fileData(document.docpath).catch(() => null);
        return {
          ...document,
          hasCache,
          hasSourceText: !!source?.pageContent,
        };
      })
    );
    const missingVectorCacheDocuments = vectorDocumentCacheStatus.filter(
      (document) => !document.hasCache
    ).length;
    const sourceTextFallbackDocuments = vectorDocumentCacheStatus.filter(
      (document) => !document.hasCache && document.hasSourceText
    ).length;
    const missingGraphTextDocuments = vectorDocumentCacheStatus.filter(
      (document) => !document.hasCache && !document.hasSourceText
    ).length;
    const eligibleVectorDocuments = Math.max(
      0,
      countFrom(vectorDocuments) - missingGraphTextDocuments
    );
    const eligibleVectorRows = vectorDocumentCacheStatus
      .filter((document) => document.hasCache || document.hasSourceText)
      .reduce((total, document) => total + Number(document.vectorRows || 0), 0);
    const counts = {
      nodes: countFrom(nodes),
      edges: countFrom(edges),
      evidence: countFrom(evidence),
      jobs: countFrom(jobs),
      completedJobs: countFrom(completedJobs),
      failedJobs: countFrom(failedJobs),
      pendingJobs: countFrom(pendingJobs),
      processingJobs: countFrom(processingJobs),
      workspaceDocuments: countFrom(workspaceDocuments),
      vectorDocuments: countFrom(vectorDocuments),
      totalVectorDocuments: countFrom(vectorDocuments),
      vectorRows: countFrom(vectorRows),
      totalVectorRows: countFrom(vectorRows),
      eligibleVectorDocuments,
      eligibleVectorRows,
      graphProcessedDocuments: countFrom(graphProcessedDocuments),
      processedDocuments: countFrom(graphProcessedDocuments),
      graphCoveredDocuments: countFrom(graphCoveredDocuments),
      noGraphOutputDocuments: countFrom(noGraphOutputDocuments),
      missingVectorCacheDocuments,
      sourceTextFallbackDocuments,
      missingGraphTextDocuments,
      terminalVectorRows: countFrom(completedJobs) + countFrom(failedJobs),
      completedVectorRows: countFrom(completedJobs),
      failedVectorRows: countFrom(failedJobs),
    };
    const terminalWorkComplete =
      counts.pendingJobs === 0 &&
      counts.processingJobs === 0 &&
      counts.terminalVectorRows >= counts.eligibleVectorRows;
    const expectedDocuments = counts.eligibleVectorDocuments;
    const backfillStatus =
      expectedDocuments > 0 &&
      counts.graphProcessedDocuments >= expectedDocuments &&
      terminalWorkComplete
        ? "complete"
        : counts.nodes === 0 && counts.edges === 0 && counts.jobs === 0
          ? "empty"
          : "partial";
    const isSparse =
      counts.nodes < 10 ||
      counts.edges < 10 ||
      counts.evidence < 10 ||
      (expectedDocuments > 0 &&
        counts.processedDocuments < Math.ceil(expectedDocuments * 0.5));
    return {
      ...counts,
      backfillStatus,
      isSparse,
    };
  },

  async upsertRepairIssue({
    workspaceId,
    documentId = "",
    chunkId = "",
    issueType,
    status = "open",
    priorityScore = 0,
    priorityReason = null,
    rootConceptHit = false,
    workspaceImportanceScore = 0,
    traversalUsageCount = 0,
    retryCount = null,
    nextRetryAt = null,
    cooldownUntil = null,
    repairMethod = null,
    repairConfidence = null,
    lastError = null,
    explainReason = null,
    quarantineReason = null,
    metadata = {},
  }) {
    await ensureTables();
    if (!workspaceId || !issueType) return null;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "KnowledgeGraphRepairIssue" (
        "workspaceId", "documentId", "chunkId", "issueType", "status",
        "priorityScore", "priorityReason", "rootConceptHit",
        "workspaceImportanceScore", "traversalUsageCount", "retryCount",
        "nextRetryAt", "cooldownUntil", "repairMethod", "repairConfidence",
        "lastError", "explainReason", "quarantineReason", "metadataJson"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT("workspaceId", "issueType", "documentId", "chunkId")
      DO UPDATE SET
        "status" = CASE
          WHEN "KnowledgeGraphRepairIssue"."status" IN ('repaired', 'ignored')
            AND (
              "KnowledgeGraphRepairIssue"."cooldownUntil" IS NOT NULL
              AND "KnowledgeGraphRepairIssue"."cooldownUntil" > CURRENT_TIMESTAMP
            )
            THEN "KnowledgeGraphRepairIssue"."status"
          WHEN "KnowledgeGraphRepairIssue"."status" = 'ignored'
            THEN "KnowledgeGraphRepairIssue"."status"
          ELSE excluded."status"
        END,
        "priorityScore" = excluded."priorityScore",
        "priorityReason" = excluded."priorityReason",
        "rootConceptHit" = excluded."rootConceptHit",
        "workspaceImportanceScore" = excluded."workspaceImportanceScore",
        "traversalUsageCount" = excluded."traversalUsageCount",
        "nextRetryAt" = COALESCE("KnowledgeGraphRepairIssue"."nextRetryAt", excluded."nextRetryAt"),
        "cooldownUntil" = COALESCE("KnowledgeGraphRepairIssue"."cooldownUntil", excluded."cooldownUntil"),
        "repairMethod" = COALESCE("KnowledgeGraphRepairIssue"."repairMethod", excluded."repairMethod"),
        "repairConfidence" = COALESCE("KnowledgeGraphRepairIssue"."repairConfidence", excluded."repairConfidence"),
        "lastError" = COALESCE(excluded."lastError", "KnowledgeGraphRepairIssue"."lastError"),
        "explainReason" = excluded."explainReason",
        "quarantineReason" = COALESCE(excluded."quarantineReason", "KnowledgeGraphRepairIssue"."quarantineReason"),
        "metadataJson" = excluded."metadataJson",
        "updatedAt" = CURRENT_TIMESTAMP`,
      Number(workspaceId),
      String(documentId || ""),
      String(chunkId || ""),
      String(issueType),
      String(status),
      Number(priorityScore || 0),
      priorityReason,
      rootConceptHit ? 1 : 0,
      Number(workspaceImportanceScore || 0),
      Number(traversalUsageCount || 0),
      retryCount === null ? 0 : Number(retryCount || 0),
      nextRetryAt ? toSqliteDateTime(new Date(nextRetryAt)) : null,
      cooldownUntil ? toSqliteDateTime(new Date(cooldownUntil)) : null,
      repairMethod,
      repairConfidence,
      lastError,
      explainReason,
      quarantineReason,
      safeJSONStringify(metadata, "{}")
    );
    return await this.getRepairIssue({
      workspaceId,
      issueType,
      documentId,
      chunkId,
    });
  },

  async getRepairIssue({
    workspaceId,
    issueType,
    documentId = "",
    chunkId = "",
  }) {
    await ensureTables();
    const row = (
      await prisma.$queryRawUnsafe(
        `SELECT ${REPAIR_ISSUE_SELECT} FROM "KnowledgeGraphRepairIssue"
	        WHERE "workspaceId" = ? AND "issueType" = ?
	          AND "documentId" = ? AND "chunkId" = ?
	        LIMIT 1`,
        Number(workspaceId),
        String(issueType),
        String(documentId || ""),
        String(chunkId || "")
      )
    )?.[0];
    return row ? toRepairIssue(row) : null;
  },

  async listRepairIssues({
    workspaceId,
    statuses = ["open", "needs_reembed"],
    limit = 25,
    includeBlocked = false,
  }) {
    await ensureTables();
    const statusList = Array.isArray(statuses) ? statuses : [statuses];
    const blockClause = includeBlocked
      ? ""
      : `AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= CURRENT_TIMESTAMP)
        AND ("cooldownUntil" IS NULL OR "cooldownUntil" <= CURRENT_TIMESTAMP)`;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${REPAIR_ISSUE_SELECT} FROM "KnowledgeGraphRepairIssue"
	      WHERE "workspaceId" = ?
	        AND "status" IN (${statusList.map(() => "?").join(",")})
	        ${blockClause}
      ORDER BY "priorityScore" DESC, "createdAt" ASC
      LIMIT ?`,
      Number(workspaceId),
      ...statusList,
      Number(limit)
    );
    return rows.map(toRepairIssue);
  },

  async updateRepairIssue(id, data = {}) {
    await ensureTables();
    if (!id) return null;
    const allowed = {
      status: "status",
      priorityScore: "priorityScore",
      priorityReason: "priorityReason",
      rootConceptHit: "rootConceptHit",
      workspaceImportanceScore: "workspaceImportanceScore",
      traversalUsageCount: "traversalUsageCount",
      retryCount: "retryCount",
      nextRetryAt: "nextRetryAt",
      cooldownUntil: "cooldownUntil",
      repairMethod: "repairMethod",
      repairConfidence: "repairConfidence",
      lastError: "lastError",
      explainReason: "explainReason",
      quarantineReason: "quarantineReason",
      metadataJson: "metadataJson",
    };
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(allowed)) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
      sets.push(`"${column}" = ?`);
      if (["nextRetryAt", "cooldownUntil"].includes(key)) {
        values.push(data[key] ? toSqliteDateTime(new Date(data[key])) : null);
      } else if (key === "metadataJson") {
        values.push(
          typeof data[key] === "string"
            ? data[key]
            : safeJSONStringify(data[key], "{}")
        );
      } else if (key === "rootConceptHit") {
        values.push(data[key] ? 1 : 0);
      } else {
        values.push(data[key]);
      }
    }
    if (sets.length === 0) return null;
    await prisma.$executeRawUnsafe(
      `UPDATE "KnowledgeGraphRepairIssue"
      SET ${sets.join(", ")}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ?`,
      ...values,
      Number(id)
    );
    const row = (
      await prisma.$queryRawUnsafe(
        `SELECT ${REPAIR_ISSUE_SELECT} FROM "KnowledgeGraphRepairIssue"
	        WHERE "id" = ? LIMIT 1`,
        Number(id)
      )
    )?.[0];
    return row ? toRepairIssue(row) : null;
  },

  async isChunkQuarantined({ workspaceId, chunkId }) {
    await ensureTables();
    if (!workspaceId || !chunkId) return false;
    const row = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS count FROM "KnowledgeGraphRepairIssue"
      WHERE "workspaceId" = ? AND "chunkId" = ? AND "status" = 'quarantined'`,
      Number(workspaceId),
      String(chunkId)
    );
    return countFrom(row) > 0;
  },

  async createRepairRun({
    workspaceId,
    trigger = "auto",
    scanned = 0,
    repaired = 0,
    failed = 0,
    skipped = 0,
    budgetExhausted = false,
    durationMs = 0,
    tokenBudgetUsed = 0,
    providerBudgetUsed = 0,
    successRate = 0,
    avgRepairLatencyMs = 0,
    providerFailureRate = 0,
    needsReembedCount = 0,
    quarantinedCount = 0,
    lowConfidenceRelationRatio = 0,
    relatedToRatio = 0,
    malformedExtractionRatio = 0,
    abnormalFanoutCount = 0,
    timeoutRate = 0,
    malformedJsonRate = 0,
    avgExtractionLatencyMs = 0,
    providerFailureTrend = 0,
    metrics = {},
  }) {
    await ensureTables();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "KnowledgeGraphRepairRun" (
        "workspaceId", "trigger", "scanned", "repaired", "failed", "skipped",
        "budgetExhausted", "durationMs", "tokenBudgetUsed",
        "providerBudgetUsed", "successRate", "avgRepairLatencyMs",
        "providerFailureRate", "needsReembedCount", "quarantinedCount",
        "lowConfidenceRelationRatio", "relatedToRatio",
        "malformedExtractionRatio", "abnormalFanoutCount", "timeoutRate",
        "malformedJsonRate", "avgExtractionLatencyMs", "providerFailureTrend",
        "metricsJson"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      Number(workspaceId),
      trigger,
      Number(scanned || 0),
      Number(repaired || 0),
      Number(failed || 0),
      Number(skipped || 0),
      budgetExhausted ? 1 : 0,
      Number(durationMs || 0),
      Number(tokenBudgetUsed || 0),
      Number(providerBudgetUsed || 0),
      Number(successRate || 0),
      Number(avgRepairLatencyMs || 0),
      Number(providerFailureRate || 0),
      Number(needsReembedCount || 0),
      Number(quarantinedCount || 0),
      Number(lowConfidenceRelationRatio || 0),
      Number(relatedToRatio || 0),
      Number(malformedExtractionRatio || 0),
      Number(abnormalFanoutCount || 0),
      Number(timeoutRate || 0),
      Number(malformedJsonRate || 0),
      Number(avgExtractionLatencyMs || 0),
      Number(providerFailureTrend || 0),
      safeJSONStringify(metrics, "{}")
    );
    const row = (
      await prisma.$queryRawUnsafe(
        `SELECT ${REPAIR_RUN_SELECT} FROM "KnowledgeGraphRepairRun"
	        WHERE "workspaceId" = ?
	        ORDER BY "id" DESC LIMIT 1`,
        Number(workspaceId)
      )
    )?.[0];
    return row ? toRepairRun(row) : null;
  },

  async repairStatus(
    workspaceId,
    { ensureSchema = true, repairLegacyVectorCache = true } = {}
  ) {
    if (ensureSchema) await ensureTables();
    if (repairLegacyVectorCache)
      await resolveLegacyVectorCacheRepairIssues(workspaceId);
    const [
      latestRun,
      openIssues,
      needsReembedIssues,
      quarantinedIssues,
      repairedIssues,
      providerFailures,
      recentIssues,
    ] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT ${REPAIR_RUN_SELECT} FROM "KnowledgeGraphRepairRun"
	        WHERE "workspaceId" = ? ORDER BY "createdAt" DESC LIMIT 1`,
        Number(workspaceId)
      ),
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*) AS count FROM "KnowledgeGraphRepairIssue"
        WHERE "workspaceId" = ? AND "status" = 'open'`,
        Number(workspaceId)
      ),
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*) AS count FROM "KnowledgeGraphRepairIssue"
        WHERE "workspaceId" = ? AND "status" = 'needs_reembed'`,
        Number(workspaceId)
      ),
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*) AS count FROM "KnowledgeGraphRepairIssue"
        WHERE "workspaceId" = ? AND "status" = 'quarantined'`,
        Number(workspaceId)
      ),
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*) AS count FROM "KnowledgeGraphRepairIssue"
        WHERE "workspaceId" = ? AND "status" = 'repaired'`,
        Number(workspaceId)
      ),
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*) AS count FROM "KnowledgeGraphRepairIssue"
        WHERE "workspaceId" = ? AND "lastError" IS NOT NULL
          AND "updatedAt" >= datetime('now', '-7 days')`,
        Number(workspaceId)
      ),
      prisma.$queryRawUnsafe(
        `SELECT ${REPAIR_ISSUE_SELECT}
	        FROM "KnowledgeGraphRepairIssue"
	        WHERE "workspaceId" = ?
	          AND NOT (
	            "issueType" = 'missing_vector_cache'
            AND "status" = 'repaired'
            AND "metadataJson" LIKE '%"hasSourceText":true%'
          )
        ORDER BY "updatedAt" DESC LIMIT 8`,
        Number(workspaceId)
      ),
    ]);
    return {
      latestRun: latestRun?.[0] ? toRepairRun(latestRun[0]) : null,
      counts: {
        open: countFrom(openIssues),
        needsReembed: countFrom(needsReembedIssues),
        quarantined: countFrom(quarantinedIssues),
        repaired: countFrom(repairedIssues),
        providerFailures7d: countFrom(providerFailures),
      },
      recentIssues: recentIssues.map(toRepairIssue),
    };
  },

  async releaseQuarantineIssue({ workspaceId, issueId }) {
    await ensureTables();
    const row = (
      await prisma.$queryRawUnsafe(
        `SELECT ${REPAIR_ISSUE_SELECT} FROM "KnowledgeGraphRepairIssue"
	        WHERE "workspaceId" = ? AND "id" = ? AND "status" = 'quarantined'
	        LIMIT 1`,
        Number(workspaceId),
        Number(issueId)
      )
    )?.[0];
    if (!row) return null;
    return await this.updateRepairIssue(row.id, {
      status: "open",
      retryCount: 0,
      nextRetryAt: null,
      quarantineReason: null,
      explainReason: "已手动解除隔离，等待下一轮修复评估。",
    });
  },

  async searchConcepts({ workspaceId, query = "", limit = 10 }) {
    await ensureTables();
    const safeLimit = Math.min(20, Math.max(1, Number(limit || 10)));
    const term = canonicalKey(query);
    if (!term) return [];
    const like = `%${term}%`;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT "id", "canonicalName", "canonicalKey", "aliases", "entityType",
        "displayNameZh", "displayNameEn", "workspaceImportanceScore",
        "recentImportanceScore"
      FROM "KnowledgeNode"
      WHERE "workspaceId" = ?
        AND (
          LOWER("canonicalName") LIKE ?
          OR LOWER("canonicalKey") LIKE ?
          OR LOWER("aliases") LIKE ?
          OR LOWER(COALESCE("displayNameZh", '')) LIKE ?
          OR LOWER(COALESCE("displayNameEn", '')) LIKE ?
        )
      ORDER BY ("workspaceImportanceScore" * 0.7 + "recentImportanceScore" * 0.3) DESC
      LIMIT ?`,
      Number(workspaceId),
      like,
      like,
      like,
      like,
      like,
      safeLimit * 3
    );
    return rows
      .map(toNode)
      .filter((node) => {
        if (node.canonicalKey.includes(term)) return true;
        return aliasIncludes(
          [
            node.displayNameZh,
            node.displayNameEn,
            node.canonicalName,
            ...(node.aliases || []),
          ],
          term
        );
      })
      .slice(0, safeLimit)
      .map((node) => ({
        id: node.id,
        canonicalName: node.canonicalName,
        displayNameZh: node.displayNameZh || null,
        displayNameEn: node.displayNameEn || null,
        aliases: node.aliases || [],
        entityType: node.entityType,
        workspaceImportanceScore: Number(node.workspaceImportanceScore || 0),
        recentImportanceScore: Number(node.recentImportanceScore || 0),
      }));
  },

  async getCache({ workspaceId, conceptKey, params }) {
    const hash = paramsHash(params);
    const row = (
      await prisma.$queryRawUnsafe(
        `SELECT "id", "workspaceId", "conceptKey", "paramsHash", "resultJson", "hitCount"
        FROM "GraphRetrievalCache"
        WHERE "workspaceId" = ? AND "conceptKey" = ? AND "paramsHash" = ?
          AND "expiresAt" > CURRENT_TIMESTAMP
        LIMIT 1`,
        Number(workspaceId),
        conceptKey,
        hash
      )
    )?.[0];
    if (!row) return null;
    prisma
      .$executeRawUnsafe(
        `UPDATE "GraphRetrievalCache"
        SET "hitCount" = "hitCount" + 1, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ?`,
        Number(row.id)
      )
      .catch((error) =>
        console.warn("[KnowledgeGraph] cache hit write skipped:", error.message)
      );
    return toCache(row);
  },

  async setCache({ workspaceId, conceptKey, params, result, ttlMs }) {
    const hash = paramsHash(params);
    const expiresAt = toSqliteDateTime(new Date(Date.now() + ttlMs));
    await prisma.$executeRawUnsafe(
      `INSERT INTO "GraphRetrievalCache" (
        "workspaceId", "conceptKey", "paramsHash", "resultJson", "expiresAt"
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT("workspaceId", "conceptKey", "paramsHash") DO UPDATE SET
        "resultJson" = excluded."resultJson",
        "expiresAt" = excluded."expiresAt",
        "updatedAt" = CURRENT_TIMESTAMP`,
      Number(workspaceId),
      conceptKey,
      hash,
      safeJSONStringify(result, "{}"),
      expiresAt
    );
  },

  async invalidateCache(workspaceId) {
    await ensureTables();
    await prisma.$executeRawUnsafe(
      `DELETE FROM "GraphRetrievalCache" WHERE "workspaceId" = ?`,
      Number(workspaceId)
    );
  },

  async recordEvidenceUsage({
    workspaceId,
    targetType,
    targetId,
    action = "view",
  }) {
    await ensureTables();
    const validTargetTypes = ["node", "edge"];
    const validActions = ["view", "jump", "copy", "ask", "expand_chunk"];
    if (
      !workspaceId ||
      !validTargetTypes.includes(String(targetType)) ||
      !targetId ||
      !validActions.includes(String(action))
    )
      return null;

    await prisma.$executeRawUnsafe(
      `INSERT INTO "KnowledgeGraphEvidenceUsage" (
        "workspaceId", "targetType", "targetId", "action", "count", "lastUsedAt"
      ) VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT("workspaceId", "targetType", "targetId", "action")
      DO UPDATE SET
        "count" = "count" + 1,
        "lastUsedAt" = CURRENT_TIMESTAMP,
        "updatedAt" = CURRENT_TIMESTAMP`,
      Number(workspaceId),
      String(targetType),
      String(targetId),
      String(action)
    );
    const row = (
      await prisma.$queryRawUnsafe(
        `SELECT * FROM "KnowledgeGraphEvidenceUsage"
        WHERE "workspaceId" = ? AND "targetType" = ? AND "targetId" = ?
          AND "action" = ?
        LIMIT 1`,
        Number(workspaceId),
        String(targetType),
        String(targetId),
        String(action)
      )
    )?.[0];
    if (String(targetType) === "node") {
      await this.markNodeMetricsStale({
        workspaceId,
        nodeIds: [targetId],
        reason: "evidence_usage_updated",
      });
    } else if (String(targetType) === "edge") {
      const edge = (
        await prisma.$queryRawUnsafe(
          `SELECT "sourceNodeId", "targetNodeId" FROM "KnowledgeEdge"
          WHERE "workspaceId" = ? AND "id" = ? LIMIT 1`,
          Number(workspaceId),
          Number(targetId)
        )
      )?.[0];
      if (edge) {
        await this.markNodeMetricsStale({
          workspaceId,
          nodeIds: [edge.sourceNodeId, edge.targetNodeId],
          reason: "edge_evidence_usage_updated",
        });
      }
    }
    return row || null;
  },

  async getNodeMetrics({ workspaceId, nodeId, formulaVersion = "metrics-v1" }) {
    await ensureTables();
    if (!workspaceId || !nodeId) return null;
    const row = (
      await prisma.$queryRawUnsafe(
        `SELECT * FROM "KnowledgeNodeMetrics"
        WHERE "workspaceId" = ? AND "nodeId" = ?
        LIMIT 1`,
        Number(workspaceId),
        Number(nodeId)
      )
    )?.[0];
    if (!row) return null;
    const metrics = toNodeMetrics(row);
    if (metrics.formulaVersion !== formulaVersion) metrics.stale = true;
    return metrics;
  },

  async markNodeMetricsStale({
    workspaceId,
    nodeIds = [],
    reason = "graph_changed",
  }) {
    await ensureTables();
    void reason;
    const ids = [...new Set((nodeIds || []).map(Number).filter(Boolean))];
    if (!workspaceId || ids.length === 0) return 0;
    for (const nodeId of ids) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "KnowledgeNodeMetrics" (
          "workspaceId", "nodeId", "formulaVersion", "stale", "lastError", "warning"
        ) VALUES (?, ?, 'metrics-v1', true, NULL, NULL)
        ON CONFLICT("workspaceId", "nodeId") DO UPDATE SET
          "stale" = true,
          "warning" = NULL,
          "lastError" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP`,
        Number(workspaceId),
        Number(nodeId)
      );
    }
    return ids.length;
  },

  async markWorkspaceNodeMetricsStale(
    workspaceId,
    reason = "workspace_changed"
  ) {
    await ensureTables();
    void reason;
    if (!workspaceId) return 0;
    await prisma.$executeRawUnsafe(
      `INSERT OR IGNORE INTO "KnowledgeNodeMetrics" (
        "workspaceId", "nodeId", "formulaVersion", "stale"
      )
      SELECT "workspaceId", "id", 'metrics-v1', true
      FROM "KnowledgeNode" WHERE "workspaceId" = ?`,
      Number(workspaceId)
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "KnowledgeNodeMetrics"
      SET "stale" = true,
        "warning" = NULL,
        "lastError" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "workspaceId" = ?`,
      Number(workspaceId)
    );
    const count = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS count FROM "KnowledgeNodeMetrics" WHERE "workspaceId" = ?`,
      Number(workspaceId)
    );
    return countFrom(count);
  },

  async ensureMissingNodeMetricRows({
    workspaceId = null,
    formulaVersion = "metrics-v1",
  } = {}) {
    await ensureTables();
    const clause = workspaceId
      ? `WHERE n."workspaceId" = ? AND m."id" IS NULL`
      : `WHERE m."id" IS NULL`;
    await prisma.$executeRawUnsafe(
      `INSERT OR IGNORE INTO "KnowledgeNodeMetrics" (
        "workspaceId", "nodeId", "formulaVersion", "stale"
      )
      SELECT n."workspaceId", n."id", ?, true
      FROM "KnowledgeNode" n
      LEFT JOIN "KnowledgeNodeMetrics" m
        ON m."workspaceId" = n."workspaceId" AND m."nodeId" = n."id"
      ${clause}`,
      formulaVersion,
      ...(workspaceId ? [Number(workspaceId)] : [])
    );
  },

  async nodeMetricsCandidates({
    workspaceId = null,
    limit = 50,
    formulaVersion = "metrics-v1",
    lockTtlMs = 900000,
  } = {}) {
    await ensureTables();
    await this.ensureMissingNodeMetricRows({ workspaceId, formulaVersion });
    const lockSeconds = Math.max(60, Math.round(Number(lockTtlMs) / 1000));
    const workspaceClause = workspaceId ? `AND n."workspaceId" = ?` : "";
    const rows = await prisma.$queryRawUnsafe(
      `WITH ranked_metrics AS (
        SELECT m.*, n."workspaceImportanceScore", n."recentImportanceScore",
          n."usageCount", n."recentUsageCount",
          COALESCE(edgeStats."edgeCount", 0) AS "edgeCount",
          COALESCE(evidenceStats."evidenceCount", 0) AS "evidenceCount",
          ROW_NUMBER() OVER (
            PARTITION BY m."workspaceId"
            ORDER BY
              n."recentUsageCount" DESC,
              n."workspaceImportanceScore" DESC,
              COALESCE(evidenceStats."evidenceCount", 0) DESC,
              COALESCE(edgeStats."edgeCount", 0) DESC,
              n."updatedAt" DESC
          ) AS "workspaceRank"
        FROM "KnowledgeNodeMetrics" m
        JOIN "KnowledgeNode" n ON n."id" = m."nodeId" AND n."workspaceId" = m."workspaceId"
        LEFT JOIN (
          SELECT "workspaceId", "nodeId", COUNT(*) AS "edgeCount" FROM (
            SELECT "workspaceId", "sourceNodeId" AS "nodeId" FROM "KnowledgeEdge"
            UNION ALL
            SELECT "workspaceId", "targetNodeId" AS "nodeId" FROM "KnowledgeEdge"
          ) GROUP BY "workspaceId", "nodeId"
        ) edgeStats ON edgeStats."workspaceId" = m."workspaceId" AND edgeStats."nodeId" = m."nodeId"
        LEFT JOIN (
          SELECT e."workspaceId", ids."nodeId", COUNT(ev."id") AS "evidenceCount"
          FROM "KnowledgeEdge" e
          JOIN (
            SELECT "id", "sourceNodeId" AS "nodeId" FROM "KnowledgeEdge"
            UNION ALL
            SELECT "id", "targetNodeId" AS "nodeId" FROM "KnowledgeEdge"
          ) ids ON ids."id" = e."id"
          LEFT JOIN "EdgeEvidence" ev ON ev."edgeId" = e."id"
          GROUP BY e."workspaceId", ids."nodeId"
        ) evidenceStats ON evidenceStats."workspaceId" = m."workspaceId" AND evidenceStats."nodeId" = m."nodeId"
        WHERE (m."stale" = true OR m."formulaVersion" != ?)
          ${workspaceClause}
          AND (m."lockedAt" IS NULL OR m."lockedAt" < datetime('now', '-' || ? || ' seconds'))
      )
      SELECT * FROM ranked_metrics
      ORDER BY
        "workspaceRank" ASC,
        "workspaceId" ASC,
        "recentUsageCount" DESC,
        "workspaceImportanceScore" DESC,
        "evidenceCount" DESC,
        "edgeCount" DESC
      LIMIT ?`,
      formulaVersion,
      ...(workspaceId ? [Number(workspaceId)] : []),
      lockSeconds,
      Number(limit || 50)
    );
    return rows.map(toNodeMetrics);
  },

  async lockNodeMetricsRow({ id, lockedBy, lockTtlMs = 900000 }) {
    await ensureTables();
    if (!id || !lockedBy) return null;
    const lockSeconds = Math.max(60, Math.round(Number(lockTtlMs) / 1000));
    await prisma.$executeRawUnsafe(
      `UPDATE "KnowledgeNodeMetrics"
      SET "lockedAt" = CURRENT_TIMESTAMP, "lockedBy" = ?
      WHERE "id" = ?
        AND ("lockedAt" IS NULL OR "lockedAt" < datetime('now', '-' || ? || ' seconds'))`,
      String(lockedBy),
      Number(id),
      lockSeconds
    );
    const row = (
      await prisma.$queryRawUnsafe(
        `SELECT * FROM "KnowledgeNodeMetrics"
        WHERE "id" = ? AND "lockedBy" = ? LIMIT 1`,
        Number(id),
        String(lockedBy)
      )
    )?.[0];
    return row ? toNodeMetrics(row) : null;
  },

  async upsertNodeMetrics({
    workspaceId,
    nodeId,
    scores = {},
    reasons = {},
    normalizedInputs = {},
    formulaVersion = "metrics-v1",
    warning = null,
    stale = false,
  }) {
    await ensureTables();
    if (!workspaceId || !nodeId) return null;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "KnowledgeNodeMetrics" (
        "workspaceId", "nodeId", "evidenceStrength", "bridgeValue",
        "knowledgeConnectivity", "traversalImportance",
        "crossDocumentPresence", "freshness", "relationDiversity",
        "sourceAuthority", "stability", "conflictSafety", "reasonsJson",
        "normalizedInputsJson", "formulaVersion", "stale", "warning",
        "lastError", "lockedAt", "lockedBy"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
      ON CONFLICT("workspaceId", "nodeId") DO UPDATE SET
        "evidenceStrength" = excluded."evidenceStrength",
        "bridgeValue" = excluded."bridgeValue",
        "knowledgeConnectivity" = excluded."knowledgeConnectivity",
        "traversalImportance" = excluded."traversalImportance",
        "crossDocumentPresence" = excluded."crossDocumentPresence",
        "freshness" = excluded."freshness",
        "relationDiversity" = excluded."relationDiversity",
        "sourceAuthority" = excluded."sourceAuthority",
        "stability" = excluded."stability",
        "conflictSafety" = excluded."conflictSafety",
        "reasonsJson" = excluded."reasonsJson",
        "normalizedInputsJson" = excluded."normalizedInputsJson",
        "formulaVersion" = excluded."formulaVersion",
        "stale" = excluded."stale",
        "warning" = excluded."warning",
        "lastError" = NULL,
        "lockedAt" = NULL,
        "lockedBy" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP`,
      Number(workspaceId),
      Number(nodeId),
      Number(scores.evidenceStrength || 0),
      Number(scores.bridgeValue || 0),
      Number(scores.knowledgeConnectivity || 0),
      Number(scores.traversalImportance || 0),
      Number(scores.crossDocumentPresence || 0),
      Number(scores.freshness || 0),
      Number(scores.relationDiversity || 0),
      Number(scores.sourceAuthority || 0),
      Number(scores.stability || 0),
      Number(scores.conflictSafety || 0),
      safeJSONStringify(reasons, "{}"),
      safeJSONStringify(normalizedInputs, "{}"),
      formulaVersion,
      stale ? 1 : 0,
      warning
    );
    return await this.getNodeMetrics({ workspaceId, nodeId, formulaVersion });
  },

  async markNodeMetricsError({ workspaceId, nodeId, error }) {
    await ensureTables();
    if (!workspaceId || !nodeId) return null;
    await prisma.$executeRawUnsafe(
      `UPDATE "KnowledgeNodeMetrics"
      SET "lastError" = ?, "lockedAt" = NULL, "lockedBy" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "workspaceId" = ? AND "nodeId" = ?`,
      String(error?.message || error || "metrics_recompute_failed"),
      Number(workspaceId),
      Number(nodeId)
    );
    return await this.getNodeMetrics({ workspaceId, nodeId });
  },

  async latestNodeMetricsSnapshot({
    workspaceId,
    nodeId,
    formulaVersion = "metrics-v1",
  }) {
    await ensureTables();
    const row = (
      await prisma.$queryRawUnsafe(
        `SELECT * FROM "KnowledgeNodeMetricsSnapshot"
        WHERE "workspaceId" = ? AND "nodeId" = ? AND "formulaVersion" = ?
        ORDER BY "createdAt" DESC LIMIT 1`,
        Number(workspaceId),
        Number(nodeId),
        formulaVersion
      )
    )?.[0];
    if (!row) return null;
    return {
      ...row,
      scores: safeJsonParse(row.scoresJson, {}),
      normalizedInputs: safeJsonParse(row.normalizedInputsJson, {}),
    };
  },

  async maybeCreateNodeMetricsSnapshot({
    workspaceId,
    nodeId,
    scores = {},
    normalizedInputs = {},
    formulaVersion = "metrics-v1",
    snapshotPeriod = "daily",
  }) {
    await ensureTables();
    if (!workspaceId || !nodeId) return null;
    const existing = (
      await prisma.$queryRawUnsafe(
        `SELECT "id" FROM "KnowledgeNodeMetricsSnapshot"
        WHERE "workspaceId" = ? AND "nodeId" = ?
          AND "formulaVersion" = ? AND "snapshotPeriod" = ?
          AND date("createdAt") = date('now')
        LIMIT 1`,
        Number(workspaceId),
        Number(nodeId),
        formulaVersion,
        snapshotPeriod
      )
    )?.[0];
    if (existing) return null;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "KnowledgeNodeMetricsSnapshot" (
        "workspaceId", "nodeId", "formulaVersion", "scoresJson",
        "normalizedInputsJson", "snapshotPeriod"
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      Number(workspaceId),
      Number(nodeId),
      formulaVersion,
      safeJSONStringify(scores, "{}"),
      safeJSONStringify(normalizedInputs, "{}"),
      snapshotPeriod
    );
    return true;
  },

  async createNodeMetricsRecomputeRun({
    workspaceId = null,
    trigger = "worker",
    formulaVersion = "metrics-v1",
    batchSize = 0,
    processed = 0,
    succeeded = 0,
    failed = 0,
    skipped = 0,
    durationMs = 0,
    lockedCount = 0,
    errors = [],
  }) {
    await ensureTables();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "KnowledgeNodeMetricsRecomputeRun" (
        "workspaceId", "trigger", "formulaVersion", "batchSize",
        "processed", "succeeded", "failed", "skipped", "durationMs",
        "lockedCount", "errorJson"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      workspaceId ? Number(workspaceId) : null,
      trigger,
      formulaVersion,
      Number(batchSize || 0),
      Number(processed || 0),
      Number(succeeded || 0),
      Number(failed || 0),
      Number(skipped || 0),
      Number(durationMs || 0),
      Number(lockedCount || 0),
      safeJSONStringify(errors, "[]")
    );
    const row = (
      await prisma.$queryRawUnsafe(
        `SELECT * FROM "KnowledgeNodeMetricsRecomputeRun"
        ORDER BY "id" DESC LIMIT 1`
      )
    )?.[0];
    return toMetricsRun(row);
  },

  async deleteDocumentGraph({ workspaceId, documentId }) {
    await ensureTables();
    if (!workspaceId || !documentId) return false;
    const edges = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT "edgeId" FROM "EdgeEvidence"
      WHERE "workspaceId" = ? AND "documentId" = ?`,
      Number(workspaceId),
      String(documentId)
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "EdgeEvidence" WHERE "workspaceId" = ? AND "documentId" = ?`,
      Number(workspaceId),
      String(documentId)
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "ConceptChunkMap" WHERE "workspaceId" = ? AND "documentId" = ?`,
      Number(workspaceId),
      String(documentId)
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "GraphExtractionJob" WHERE "workspaceId" = ? AND "documentId" = ?`,
      Number(workspaceId),
      String(documentId)
    );
    for (const edge of edges) {
      const count = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*) AS count FROM "EdgeEvidence" WHERE "edgeId" = ?`,
        Number(edge.edgeId)
      );
      if (Number(count?.[0]?.count || 0) === 0) {
        await prisma.$executeRawUnsafe(
          `DELETE FROM "KnowledgeEdge" WHERE "id" = ?`,
          Number(edge.edgeId)
        );
      }
    }
    await this.invalidateCache(workspaceId);
    await this.markWorkspaceNodeMetricsStale(
      workspaceId,
      "document_graph_deleted"
    );
    return true;
  },
};

module.exports = { KnowledgeGraph };
