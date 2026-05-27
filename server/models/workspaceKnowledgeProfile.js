const prisma = require("../utils/prisma");
const { safeJsonParse } = require("../utils/http");

const PROFILE_VERSION = "workspace-profile-v1";
const BOOK_STRUCTURE_VERSION = "book-structure-v1";
const PROFILE_TYPES = [
  "book",
  "course",
  "research",
  "project",
  "loose_notes",
  "mixed",
];
const BOOK_STRUCTURE_TYPES = [
  "person_driven",
  "concept_driven",
  "chronology_driven",
  "problem_driven",
  "method_driven",
  "chapter_driven",
  "argument_driven",
  "mixed_structure",
];

let tablesReady = false;

function json(value, fallback = "{}") {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return fallback;
  }
}

function sqliteDate(date = new Date()) {
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
}

function bool(value) {
  return value === true || value === 1 || value === "1";
}

function profileRow(row = null) {
  if (!row) return null;
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspaceId),
    profileType: row.profileType,
    confidence: Number(row.confidence || 0),
    primaryDocumentIds: safeJsonParse(row.primaryDocumentIdsJson, []),
    mainTopic: row.mainTopic || "",
    detectedStructure: safeJsonParse(row.detectedStructureJson, {}),
    suggestedGraphStrategy: row.suggestedGraphStrategy || "",
    profileVersion: row.profileVersion || PROFILE_VERSION,
    manualOverride: bool(row.manualOverride),
    overrideSource: row.overrideSource || null,
    overrideReason: row.overrideReason || null,
    originalProfileType: row.originalProfileType || null,
    originalConfidence:
      row.originalConfidence === null || row.originalConfidence === undefined
        ? null
        : Number(row.originalConfidence),
    userDescription: row.userDescription || "",
    metadata: safeJsonParse(row.metadataJson, {}),
    lastAnalyzedAt: row.lastAnalyzedAt || null,
    nextRefreshAfter: row.nextRefreshAfter || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function bookRow(row = null) {
  if (!row) return null;
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspaceId),
    structureType: row.structureType,
    confidence: Number(row.confidence || 0),
    primaryAxis: row.primaryAxis || "",
    secondaryAxes: safeJsonParse(row.secondaryAxesJson, []),
    recommendedNodeTypes: safeJsonParse(row.recommendedNodeTypesJson, []),
    recommendedPathTypes: safeJsonParse(row.recommendedPathTypesJson, []),
    extractionFocus: safeJsonParse(row.extractionFocusJson, []),
    recommendationFocus: safeJsonParse(row.recommendationFocusJson, []),
    structureVersion: row.structureVersion || BOOK_STRUCTURE_VERSION,
    manualOverride: bool(row.manualOverride),
    overrideSource: row.overrideSource || null,
    overrideReason: row.overrideReason || null,
    originalStructureType: row.originalStructureType || null,
    originalConfidence:
      row.originalConfidence === null || row.originalConfidence === undefined
        ? null
        : Number(row.originalConfidence),
    metadata: safeJsonParse(row.metadataJson, {}),
    lastAnalyzedAt: row.lastAnalyzedAt || null,
    nextRefreshAfter: row.nextRefreshAfter || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function ensureTables() {
  if (tablesReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "WorkspaceKnowledgeProfile" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "workspaceId" INTEGER NOT NULL,
      "profileType" TEXT NOT NULL DEFAULT 'mixed',
      "confidence" REAL NOT NULL DEFAULT 0,
      "primaryDocumentIdsJson" TEXT NOT NULL DEFAULT '[]',
      "mainTopic" TEXT,
      "detectedStructureJson" TEXT NOT NULL DEFAULT '{}',
      "suggestedGraphStrategy" TEXT,
      "profileVersion" TEXT NOT NULL DEFAULT '${PROFILE_VERSION}',
      "manualOverride" BOOLEAN NOT NULL DEFAULT false,
      "overrideSource" TEXT,
      "overrideReason" TEXT,
      "originalProfileType" TEXT,
      "originalConfidence" REAL,
      "userDescription" TEXT,
      "metadataJson" TEXT NOT NULL DEFAULT '{}',
      "lastAnalyzedAt" DATETIME,
      "nextRefreshAfter" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "WorkspaceKnowledgeProfile_workspaceId_key"
    ON "WorkspaceKnowledgeProfile"("workspaceId")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "BookStructureAnalysis" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "workspaceId" INTEGER NOT NULL,
      "structureType" TEXT NOT NULL DEFAULT 'mixed_structure',
      "confidence" REAL NOT NULL DEFAULT 0,
      "primaryAxis" TEXT,
      "secondaryAxesJson" TEXT NOT NULL DEFAULT '[]',
      "recommendedNodeTypesJson" TEXT NOT NULL DEFAULT '[]',
      "recommendedPathTypesJson" TEXT NOT NULL DEFAULT '[]',
      "extractionFocusJson" TEXT NOT NULL DEFAULT '[]',
      "recommendationFocusJson" TEXT NOT NULL DEFAULT '[]',
      "structureVersion" TEXT NOT NULL DEFAULT '${BOOK_STRUCTURE_VERSION}',
      "manualOverride" BOOLEAN NOT NULL DEFAULT false,
      "overrideSource" TEXT,
      "overrideReason" TEXT,
      "originalStructureType" TEXT,
      "originalConfidence" REAL,
      "metadataJson" TEXT NOT NULL DEFAULT '{}',
      "lastAnalyzedAt" DATETIME,
      "nextRefreshAfter" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "BookStructureAnalysis_workspaceId_key"
    ON "BookStructureAnalysis"("workspaceId")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "NodeChunkBinding" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "workspaceId" INTEGER NOT NULL,
      "nodeKey" TEXT NOT NULL,
      "documentId" TEXT NOT NULL,
      "chunkId" TEXT NOT NULL,
      "relevanceScore" REAL NOT NULL DEFAULT 0,
      "evidenceType" TEXT NOT NULL DEFAULT 'original',
      "metadataJson" TEXT NOT NULL DEFAULT '{}',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "NodeChunkBinding_workspaceId_nodeKey_documentId_chunkId_evidenceType_key"
    ON "NodeChunkBinding"("workspaceId","nodeKey","documentId","chunkId","evidenceType")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "NodeChunkBinding_workspaceId_nodeKey_idx"
    ON "NodeChunkBinding"("workspaceId","nodeKey")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "NodeLearningState" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "workspaceId" INTEGER NOT NULL,
      "userId" INTEGER NOT NULL DEFAULT 0,
      "nodeKey" TEXT NOT NULL,
      "viewedCount" INTEGER NOT NULL DEFAULT 0,
      "lastViewedAt" DATETIME,
      "quizAttemptCount" INTEGER NOT NULL DEFAULT 0,
      "wrongCount" INTEGER NOT NULL DEFAULT 0,
      "correctCount" INTEGER NOT NULL DEFAULT 0,
      "masteryScore" REAL NOT NULL DEFAULT 0,
      "confusionScore" REAL NOT NULL DEFAULT 0,
      "supplementCount" INTEGER NOT NULL DEFAULT 0,
      "hasUserSupplement" BOOLEAN NOT NULL DEFAULT false,
      "recommendedCount" INTEGER NOT NULL DEFAULT 0,
      "dismissedCount" INTEGER NOT NULL DEFAULT 0,
      "lastRecommendedAt" DATETIME,
      "userMarkedImportant" BOOLEAN NOT NULL DEFAULT false,
      "metadataJson" TEXT NOT NULL DEFAULT '{}',
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "NodeLearningState_workspaceId_userId_nodeKey_key"
    ON "NodeLearningState"("workspaceId","userId","nodeKey")
  `);
  tablesReady = true;
}

async function getProfile(workspaceId) {
  await ensureTables();
  const row = (
    await prisma.$queryRawUnsafe(
      `SELECT "id", "workspaceId", "profileType", "confidence",
        "primaryDocumentIdsJson", "mainTopic", "detectedStructureJson",
        "suggestedGraphStrategy", "profileVersion", "manualOverride",
        "overrideSource", "overrideReason", "originalProfileType",
        "originalConfidence", "userDescription", "metadataJson",
        CAST("lastAnalyzedAt" AS TEXT) AS "lastAnalyzedAt",
        CAST("nextRefreshAfter" AS TEXT) AS "nextRefreshAfter",
        CAST("createdAt" AS TEXT) AS "createdAt",
        CAST("updatedAt" AS TEXT) AS "updatedAt"
      FROM "WorkspaceKnowledgeProfile" WHERE "workspaceId" = ? LIMIT 1`,
      Number(workspaceId)
    )
  )?.[0];
  return profileRow(row);
}

async function upsertProfile(workspaceId, data = {}) {
  await ensureTables();
  const now = sqliteDate();
  const next = sqliteDate(new Date(Date.now() + 24 * 60 * 60 * 1000));
  await prisma.$executeRawUnsafe(
    `INSERT INTO "WorkspaceKnowledgeProfile" (
      "workspaceId","profileType","confidence","primaryDocumentIdsJson","mainTopic",
      "detectedStructureJson","suggestedGraphStrategy","profileVersion",
      "manualOverride","overrideSource","overrideReason","originalProfileType",
      "originalConfidence","userDescription","metadataJson","lastAnalyzedAt",
      "nextRefreshAfter","createdAt","updatedAt"
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT("workspaceId") DO UPDATE SET
      "profileType" = excluded."profileType",
      "confidence" = excluded."confidence",
      "primaryDocumentIdsJson" = excluded."primaryDocumentIdsJson",
      "mainTopic" = excluded."mainTopic",
      "detectedStructureJson" = excluded."detectedStructureJson",
      "suggestedGraphStrategy" = excluded."suggestedGraphStrategy",
      "profileVersion" = excluded."profileVersion",
      "manualOverride" = excluded."manualOverride",
      "overrideSource" = excluded."overrideSource",
      "overrideReason" = excluded."overrideReason",
      "originalProfileType" = excluded."originalProfileType",
      "originalConfidence" = excluded."originalConfidence",
      "userDescription" = excluded."userDescription",
      "metadataJson" = excluded."metadataJson",
      "lastAnalyzedAt" = excluded."lastAnalyzedAt",
      "nextRefreshAfter" = excluded."nextRefreshAfter",
      "updatedAt" = CURRENT_TIMESTAMP`,
    Number(workspaceId),
    data.profileType || "mixed",
    Number(data.confidence || 0),
    json(data.primaryDocumentIds || [], "[]"),
    data.mainTopic || "",
    json(data.detectedStructure || {}),
    data.suggestedGraphStrategy || "",
    data.profileVersion || PROFILE_VERSION,
    data.manualOverride === true,
    data.overrideSource || null,
    data.overrideReason || null,
    data.originalProfileType || null,
    data.originalConfidence ?? null,
    data.userDescription || "",
    json(data.metadata || {}),
    data.lastAnalyzedAt || now,
    data.nextRefreshAfter || next
  );
  return await getProfile(workspaceId);
}

async function getBookStructure(workspaceId) {
  await ensureTables();
  const row = (
    await prisma.$queryRawUnsafe(
      `SELECT "id", "workspaceId", "structureType", "confidence",
        "primaryAxis", "secondaryAxesJson", "recommendedNodeTypesJson",
        "recommendedPathTypesJson", "extractionFocusJson",
        "recommendationFocusJson", "structureVersion", "manualOverride",
        "overrideSource", "overrideReason", "originalStructureType",
        "originalConfidence", "metadataJson",
        CAST("lastAnalyzedAt" AS TEXT) AS "lastAnalyzedAt",
        CAST("nextRefreshAfter" AS TEXT) AS "nextRefreshAfter",
        CAST("createdAt" AS TEXT) AS "createdAt",
        CAST("updatedAt" AS TEXT) AS "updatedAt"
      FROM "BookStructureAnalysis" WHERE "workspaceId" = ? LIMIT 1`,
      Number(workspaceId)
    )
  )?.[0];
  return bookRow(row);
}

async function upsertBookStructure(workspaceId, data = {}) {
  await ensureTables();
  const now = sqliteDate();
  const next = sqliteDate(new Date(Date.now() + 24 * 60 * 60 * 1000));
  await prisma.$executeRawUnsafe(
    `INSERT INTO "BookStructureAnalysis" (
      "workspaceId","structureType","confidence","primaryAxis","secondaryAxesJson",
      "recommendedNodeTypesJson","recommendedPathTypesJson","extractionFocusJson",
      "recommendationFocusJson","structureVersion","manualOverride",
      "overrideSource","overrideReason","originalStructureType","originalConfidence",
      "metadataJson","lastAnalyzedAt","nextRefreshAfter","createdAt","updatedAt"
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT("workspaceId") DO UPDATE SET
      "structureType" = excluded."structureType",
      "confidence" = excluded."confidence",
      "primaryAxis" = excluded."primaryAxis",
      "secondaryAxesJson" = excluded."secondaryAxesJson",
      "recommendedNodeTypesJson" = excluded."recommendedNodeTypesJson",
      "recommendedPathTypesJson" = excluded."recommendedPathTypesJson",
      "extractionFocusJson" = excluded."extractionFocusJson",
      "recommendationFocusJson" = excluded."recommendationFocusJson",
      "structureVersion" = excluded."structureVersion",
      "manualOverride" = excluded."manualOverride",
      "overrideSource" = excluded."overrideSource",
      "overrideReason" = excluded."overrideReason",
      "originalStructureType" = excluded."originalStructureType",
      "originalConfidence" = excluded."originalConfidence",
      "metadataJson" = excluded."metadataJson",
      "lastAnalyzedAt" = excluded."lastAnalyzedAt",
      "nextRefreshAfter" = excluded."nextRefreshAfter",
      "updatedAt" = CURRENT_TIMESTAMP`,
    Number(workspaceId),
    data.structureType || "mixed_structure",
    Number(data.confidence || 0),
    data.primaryAxis || "",
    json(data.secondaryAxes || [], "[]"),
    json(data.recommendedNodeTypes || [], "[]"),
    json(data.recommendedPathTypes || [], "[]"),
    json(data.extractionFocus || [], "[]"),
    json(data.recommendationFocus || [], "[]"),
    data.structureVersion || BOOK_STRUCTURE_VERSION,
    data.manualOverride === true,
    data.overrideSource || null,
    data.overrideReason || null,
    data.originalStructureType || null,
    data.originalConfidence ?? null,
    json(data.metadata || {}),
    data.lastAnalyzedAt || now,
    data.nextRefreshAfter || next
  );
  return await getBookStructure(workspaceId);
}

module.exports = {
  WorkspaceKnowledgeProfile: {
    PROFILE_TYPES,
    PROFILE_VERSION,
    ensureTables,
    get: getProfile,
    upsert: upsertProfile,
  },
  BookStructureAnalysis: {
    BOOK_STRUCTURE_TYPES,
    BOOK_STRUCTURE_VERSION,
    ensureTables,
    get: getBookStructure,
    upsert: upsertBookStructure,
  },
};
