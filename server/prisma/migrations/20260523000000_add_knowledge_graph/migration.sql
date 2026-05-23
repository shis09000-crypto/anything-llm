CREATE TABLE IF NOT EXISTS "KnowledgeNode" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "workspaceId" INTEGER NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "canonicalKey" TEXT NOT NULL,
    "aliases" TEXT NOT NULL DEFAULT '[]',
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
);

CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeNode_workspaceId_canonicalKey_key" ON "KnowledgeNode"("workspaceId", "canonicalKey");
CREATE INDEX IF NOT EXISTS "KnowledgeNode_workspaceId_entityType_idx" ON "KnowledgeNode"("workspaceId", "entityType");
CREATE INDEX IF NOT EXISTS "KnowledgeNode_workspaceId_canonicalKey_idx" ON "KnowledgeNode"("workspaceId", "canonicalKey");
CREATE INDEX IF NOT EXISTS "KnowledgeNode_workspaceId_globalImportanceScore_idx" ON "KnowledgeNode"("workspaceId", "globalImportanceScore");
CREATE INDEX IF NOT EXISTS "KnowledgeNode_workspaceId_workspaceImportanceScore_idx" ON "KnowledgeNode"("workspaceId", "workspaceImportanceScore");
CREATE INDEX IF NOT EXISTS "KnowledgeNode_workspaceId_recentImportanceScore_idx" ON "KnowledgeNode"("workspaceId", "recentImportanceScore");
CREATE INDEX IF NOT EXISTS "KnowledgeNode_workspaceId_lastReferencedAt_idx" ON "KnowledgeNode"("workspaceId", "lastReferencedAt");

CREATE TABLE IF NOT EXISTS "KnowledgeEdge" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "workspaceId" INTEGER NOT NULL,
    "sourceNodeId" INTEGER NOT NULL,
    "targetNodeId" INTEGER NOT NULL,
    "relationType" TEXT NOT NULL,
    "relationLabel" TEXT,
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
);

CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeEdge_workspaceId_sourceNodeId_targetNodeId_relationType_key" ON "KnowledgeEdge"("workspaceId", "sourceNodeId", "targetNodeId", "relationType");
CREATE INDEX IF NOT EXISTS "KnowledgeEdge_workspaceId_sourceNodeId_idx" ON "KnowledgeEdge"("workspaceId", "sourceNodeId");
CREATE INDEX IF NOT EXISTS "KnowledgeEdge_workspaceId_targetNodeId_idx" ON "KnowledgeEdge"("workspaceId", "targetNodeId");
CREATE INDEX IF NOT EXISTS "KnowledgeEdge_workspaceId_relationType_idx" ON "KnowledgeEdge"("workspaceId", "relationType");
CREATE INDEX IF NOT EXISTS "KnowledgeEdge_workspaceId_confidence_idx" ON "KnowledgeEdge"("workspaceId", "confidence");
CREATE INDEX IF NOT EXISTS "KnowledgeEdge_workspaceId_weight_idx" ON "KnowledgeEdge"("workspaceId", "weight");

CREATE TABLE IF NOT EXISTS "EdgeEvidence" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "workspaceId" INTEGER NOT NULL,
    "edgeId" INTEGER NOT NULL,
    "documentId" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "snippet" TEXT,
    "confidence" REAL NOT NULL DEFAULT 0,
    "extractionJobId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "EdgeEvidence_edgeId_chunkId_key" ON "EdgeEvidence"("edgeId", "chunkId");
CREATE INDEX IF NOT EXISTS "EdgeEvidence_workspaceId_edgeId_idx" ON "EdgeEvidence"("workspaceId", "edgeId");
CREATE INDEX IF NOT EXISTS "EdgeEvidence_workspaceId_documentId_idx" ON "EdgeEvidence"("workspaceId", "documentId");
CREATE INDEX IF NOT EXISTS "EdgeEvidence_workspaceId_chunkId_idx" ON "EdgeEvidence"("workspaceId", "chunkId");

CREATE TABLE IF NOT EXISTS "ConceptChunkMap" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "workspaceId" INTEGER NOT NULL,
    "nodeId" INTEGER NOT NULL,
    "documentId" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "relevanceScore" REAL NOT NULL DEFAULT 0,
    "mentionCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "ConceptChunkMap_workspaceId_nodeId_chunkId_key" ON "ConceptChunkMap"("workspaceId", "nodeId", "chunkId");
CREATE INDEX IF NOT EXISTS "ConceptChunkMap_workspaceId_nodeId_idx" ON "ConceptChunkMap"("workspaceId", "nodeId");
CREATE INDEX IF NOT EXISTS "ConceptChunkMap_workspaceId_chunkId_idx" ON "ConceptChunkMap"("workspaceId", "chunkId");
CREATE INDEX IF NOT EXISTS "ConceptChunkMap_workspaceId_documentId_idx" ON "ConceptChunkMap"("workspaceId", "documentId");

CREATE TABLE IF NOT EXISTS "GraphExtractionJob" (
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
);

CREATE UNIQUE INDEX IF NOT EXISTS "GraphExtractionJob_workspaceId_chunkId_key" ON "GraphExtractionJob"("workspaceId", "chunkId");
CREATE INDEX IF NOT EXISTS "GraphExtractionJob_status_idx" ON "GraphExtractionJob"("status");
CREATE INDEX IF NOT EXISTS "GraphExtractionJob_workspaceId_chunkId_idx" ON "GraphExtractionJob"("workspaceId", "chunkId");
CREATE INDEX IF NOT EXISTS "GraphExtractionJob_workspaceId_documentId_idx" ON "GraphExtractionJob"("workspaceId", "documentId");

CREATE TABLE IF NOT EXISTS "GraphRetrievalCache" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "workspaceId" INTEGER NOT NULL,
    "conceptKey" TEXT NOT NULL,
    "paramsHash" TEXT NOT NULL,
    "resultJson" TEXT NOT NULL,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "GraphRetrievalCache_workspaceId_conceptKey_paramsHash_key" ON "GraphRetrievalCache"("workspaceId", "conceptKey", "paramsHash");
CREATE INDEX IF NOT EXISTS "GraphRetrievalCache_workspaceId_conceptKey_idx" ON "GraphRetrievalCache"("workspaceId", "conceptKey");
CREATE INDEX IF NOT EXISTS "GraphRetrievalCache_workspaceId_expiresAt_idx" ON "GraphRetrievalCache"("workspaceId", "expiresAt");
