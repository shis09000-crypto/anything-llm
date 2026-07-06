const {
  lazyDataAccessFacade,
  lazyDataAccessProperty,
} = require("../../dataAccess/lazyFacade");
const KnowledgeGraphData = lazyDataAccessFacade("knowledgeGraph");
const knowledgeGraphDb = KnowledgeGraphData.db;
const { cachedVectorInformation, fileData } = require("../../files");
const KnowledgeGraph = lazyDataAccessProperty("knowledgeGraph", "model");
const { vectorRowsForDocument } = require("../chunks");
const { priorityForIssue } = require("./prioritize");
const { shouldQuarantineDensity, quarantineIssue } = require("./quarantine");

const STALE_PROCESSING_MS = 30 * 60 * 1_000;

async function scanWorkspaceForRepairIssues({ workspace, limit = 100 } = {}) {
  if (!workspace?.id) return { scanned: 0, issues: [] };
  await KnowledgeGraph.ensureTables();
  const documents = await knowledgeGraphDb.workspace_documents.findMany({
    where: {
      workspaceId: Number(workspace.id),
      embeddingStatus: "completed",
    },
    orderBy: { id: "asc" },
    take: Number(limit || 100),
  });
  const issues = [];
  for (const document of documents) {
    const vectorRows = await vectorRowsForDocument(document.docId);
    if (vectorRows.length === 0) continue;
    const source = await fileData(document.docpath).catch(() => null);
    const hasCache = await cachedVectorInformation(document.docpath, true);
    const docSignal = await documentGraphSignal({
      workspaceId: workspace.id,
      documentId: document.docId,
    });

    if (!hasCache) {
      const issueType = source?.pageContent
        ? "missing_vector_cache"
        : "missing_graph_text";
      const status = source?.pageContent ? "open" : "unrecoverable";
      const issue = await writeIssue({
        workspaceId: workspace.id,
        document,
        chunkId: "",
        issueType,
        status,
        docSignal,
        explainReason: source?.pageContent
          ? "标准 vector-cache 缺失；可尝试从 vector DB 读回或使用源文档文本补齐 KG。"
          : "标准 vector-cache 与源文档文本都缺失，无法安全恢复 graph 文本。",
        metadata: {
          vectorRows: vectorRows.length,
          hasSourceText: !!source?.pageContent,
        },
      });
      issues.push(issue);
    }

    for (const row of vectorRows) {
      const job = await graphJob(workspace.id, row.vectorId);
      if (!job) {
        issues.push(
          await writeIssue({
            workspaceId: workspace.id,
            document,
            chunkId: row.vectorId,
            issueType: "missing_graph_job",
            docSignal,
            explainReason:
              "该 vector chunk 已存在，但没有对应 GraphExtractionJob。",
          })
        );
        continue;
      }
      if (job.status === "processing" && isStale(job.updatedAt)) {
        issues.push(
          await writeIssue({
            workspaceId: workspace.id,
            document,
            chunkId: row.vectorId,
            issueType: "stale_processing_job",
            docSignal,
            explainReason:
              "GraphExtractionJob 长时间停留在 processing，可能由进程中断造成。",
            metadata: { jobId: job.id, updatedAt: job.updatedAt },
          })
        );
      }
      if (job.status === "failed") {
        issues.push(
          await writeIssue({
            workspaceId: workspace.id,
            document,
            chunkId: row.vectorId,
            issueType: "failed_graph_job",
            docSignal,
            explainReason:
              "GraphExtractionJob 失败，可按退避策略重试；持续失败会进入隔离。",
            metadata: {
              jobId: job.id,
              retryCount: job.retryCount,
              errorMessage: job.errorMessage,
            },
          })
        );
      }
    }

    const density = await relationDensity({
      workspaceId: workspace.id,
      documentId: document.docId,
    });
    if (shouldQuarantineDensity(density)) {
      issues.push(
        await quarantineIssue({
          workspaceId: workspace.id,
          documentId: document.docId,
          reason:
            "该文档关系密度异常，低置信或 related_to 关系比例过高，已暂停后续 graph ingestion。",
          metadata: density,
        })
      );
    }
  }
  return { scanned: documents.length, issues: issues.filter(Boolean) };
}

async function writeIssue({
  workspaceId,
  document,
  chunkId,
  issueType,
  status = "open",
  docSignal = {},
  explainReason,
  metadata = {},
}) {
  const priority = priorityForIssue({
    issueType,
    workspaceImportanceScore: docSignal.workspaceImportanceScore,
    traversalUsageCount: docSignal.traversalUsageCount,
    rootConceptHit: docSignal.rootConceptHit,
    hasEvidenceDependency: docSignal.hasEvidenceDependency,
  });
  return await KnowledgeGraph.upsertRepairIssue({
    workspaceId,
    documentId: document.docId,
    chunkId,
    issueType,
    status,
    ...priority,
    rootConceptHit: docSignal.rootConceptHit,
    workspaceImportanceScore: docSignal.workspaceImportanceScore,
    traversalUsageCount: docSignal.traversalUsageCount,
    explainReason,
    metadata: {
      documentPath: document.docpath,
      filename: document.filename,
      ...metadata,
    },
  });
}

async function graphJob(workspaceId, chunkId) {
  return (
    await knowledgeGraphDb.$queryRawUnsafe(
      `SELECT * FROM "GraphExtractionJob"
      WHERE "workspaceId" = ? AND "chunkId" = ?
      LIMIT 1`,
      Number(workspaceId),
      String(chunkId)
    )
  )?.[0];
}

function isStale(updatedAt) {
  const value = new Date(updatedAt).getTime();
  return Number.isFinite(value) && Date.now() - value > STALE_PROCESSING_MS;
}

async function documentGraphSignal({ workspaceId, documentId }) {
  const [nodeScore, usage, evidence] = await Promise.all([
    knowledgeGraphDb.$queryRawUnsafe(
      `SELECT MAX(n."workspaceImportanceScore") AS score
      FROM "ConceptChunkMap" c
      JOIN "KnowledgeNode" n ON n."id" = c."nodeId"
      WHERE c."workspaceId" = ? AND c."documentId" = ?`,
      Number(workspaceId),
      String(documentId)
    ),
    knowledgeGraphDb.$queryRawUnsafe(
      `SELECT COALESCE(SUM(e."usageCount"), 0) + COALESCE(SUM(n."usageCount"), 0) AS count
      FROM "ConceptChunkMap" c
      LEFT JOIN "KnowledgeNode" n ON n."id" = c."nodeId"
      LEFT JOIN "KnowledgeEdge" e
        ON e."workspaceId" = c."workspaceId"
        AND (e."sourceNodeId" = c."nodeId" OR e."targetNodeId" = c."nodeId")
      WHERE c."workspaceId" = ? AND c."documentId" = ?`,
      Number(workspaceId),
      String(documentId)
    ),
    knowledgeGraphDb.$queryRawUnsafe(
      `SELECT COUNT(*) AS count FROM "EdgeEvidence"
      WHERE "workspaceId" = ? AND "documentId" = ?`,
      Number(workspaceId),
      String(documentId)
    ),
  ]);
  const workspaceImportanceScore = Number(nodeScore?.[0]?.score || 0);
  const traversalUsageCount = Number(usage?.[0]?.count || 0);
  return {
    workspaceImportanceScore,
    traversalUsageCount,
    rootConceptHit: workspaceImportanceScore >= 0.7,
    hasEvidenceDependency: Number(evidence?.[0]?.count || 0) > 0,
  };
}

async function relationDensity({ workspaceId, documentId }) {
  const [edges, lowConfidence, relatedTo] = await Promise.all([
    knowledgeGraphDb.$queryRawUnsafe(
      `SELECT COUNT(DISTINCT e."id") AS count
      FROM "KnowledgeEdge" e
      JOIN "EdgeEvidence" ev ON ev."edgeId" = e."id"
      WHERE ev."workspaceId" = ? AND ev."documentId" = ?`,
      Number(workspaceId),
      String(documentId)
    ),
    knowledgeGraphDb.$queryRawUnsafe(
      `SELECT COUNT(DISTINCT e."id") AS count
      FROM "KnowledgeEdge" e
      JOIN "EdgeEvidence" ev ON ev."edgeId" = e."id"
      WHERE ev."workspaceId" = ? AND ev."documentId" = ?
        AND e."confidence" < 0.45`,
      Number(workspaceId),
      String(documentId)
    ),
    knowledgeGraphDb.$queryRawUnsafe(
      `SELECT COUNT(DISTINCT e."id") AS count
      FROM "KnowledgeEdge" e
      JOIN "EdgeEvidence" ev ON ev."edgeId" = e."id"
      WHERE ev."workspaceId" = ? AND ev."documentId" = ?
        AND e."relationType" = 'related_to'`,
      Number(workspaceId),
      String(documentId)
    ),
  ]);
  const edgeCount = Number(edges?.[0]?.count || 0);
  return {
    edgeCount,
    lowConfidenceRatio: edgeCount
      ? Number(lowConfidence?.[0]?.count || 0) / edgeCount
      : 0,
    relatedToRatio: edgeCount
      ? Number(relatedTo?.[0]?.count || 0) / edgeCount
      : 0,
  };
}

module.exports = { scanWorkspaceForRepairIssues };
