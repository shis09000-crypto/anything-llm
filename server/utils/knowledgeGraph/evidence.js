const {
  lazyDataAccessFacade,
  lazyDataAccessProperty,
} = require("../dataAccess/lazyFacade");
const KnowledgeGraphData = lazyDataAccessFacade("knowledgeGraph");
const knowledgeGraphDb = KnowledgeGraphData.db;
const { safeJsonParse } = require("../http");
const KnowledgeGraph = lazyDataAccessProperty("knowledgeGraph", "model");
const { chunksForDocument } = require("./chunks");

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const CLUSTERS = {
  definition: "定义",
  mechanism: "机制",
  structure: "结构",
  history: "历史",
  comparison: "对比",
  application: "应用",
  other: "其他",
};

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function safeDate(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

function aliasesFrom(row = {}) {
  return safeJsonParse(row.aliases, []);
}

function displayConcept(row = {}) {
  return {
    id: row.id,
    canonicalName: row.canonicalName,
    displayNameZh: row.displayNameZh || null,
    displayNameEn: row.displayNameEn || row.canonicalName,
    aliases: Array.isArray(row.aliases) ? row.aliases : aliasesFrom(row),
    entityType: row.entityType,
    globalImportanceScore: Number(row.globalImportanceScore || 0),
    workspaceImportanceScore: Number(row.workspaceImportanceScore || 0),
    recentImportanceScore: Number(row.recentImportanceScore || 0),
    summary: row.summary || "",
  };
}

function conceptImportance(...nodes) {
  const scores = nodes
    .filter(Boolean)
    .map((node) =>
      clamp(
        Number(node.workspaceImportanceScore || 0) * 0.55 +
          Number(node.recentImportanceScore || 0) * 0.3 +
          Number(node.globalImportanceScore || 0) * 0.15
      )
    );
  if (!scores.length) return 0;
  return clamp(scores.reduce((sum, score) => sum + score, 0) / scores.length);
}

function freshnessScore(value) {
  const date = safeDate(value);
  if (!date) return 0.35;
  const ageDays = Math.max(0, (Date.now() - date.getTime()) / 86_400_000);
  if (ageDays <= 7) return 1;
  if (ageDays <= 30) return 0.78;
  if (ageDays <= 90) return 0.58;
  if (ageDays <= 180) return 0.42;
  return 0.28;
}

function chunkQualityScore({ chunkText = "", snippet = "" } = {}) {
  const chunkLength = String(chunkText || "").trim().length;
  const snippetLength = String(snippet || "").trim().length;
  if (chunkLength >= 400 && snippetLength >= 60) return 0.9;
  if (chunkLength >= 180 && snippetLength >= 40) return 0.72;
  if (chunkLength >= 60 || snippetLength >= 40) return 0.55;
  if (snippetLength > 0) return 0.38;
  return 0.18;
}

function sourceAuthorityScore({
  document = null,
  chunkText = "",
  coverage = 0,
} = {}) {
  const metadata = safeJsonParse(document?.metadata, {});
  const reasons = [];
  let score = 0.42;

  if (document?.pinned || document?.watched) {
    score += 0.12;
    reasons.push("文档在工作区中被标记为重要来源。");
  }
  if (Number(coverage || 0) >= 0.5) {
    score += 0.14;
    reasons.push("该文档已有较完整的图谱覆盖。");
  }
  if (String(chunkText || "").trim().length >= 300) {
    score += 0.12;
    reasons.push("chunk 文本较完整，便于定位原始上下文。");
  }
  if (metadata.title || document?.filename) {
    score += 0.06;
    reasons.push("来源文档具备可追踪标题。");
  }
  if (metadata.source || metadata.url) {
    score += 0.08;
    reasons.push("来源包含外部引用信息。");
  }
  if (!reasons.length) reasons.push("使用工作区默认来源可信度。");

  return {
    sourceAuthority: clamp(score),
    sourceAuthorityReasons: reasons,
  };
}

function relationStability(evidenceRows = []) {
  const rows = evidenceRows || [];
  const docs = new Set(rows.map((row) => row.documentId).filter(Boolean));
  const dates = rows
    .map((row) => safeDate(row.createdAt))
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime());
  const spanDays =
    dates.length >= 2
      ? Math.max(0, (dates[dates.length - 1] - dates[0]) / 86_400_000)
      : 0;
  const confidenceValues = rows.map((row) => Number(row.confidence || 0));
  const avgConfidence = confidenceValues.length
    ? confidenceValues.reduce((sum, item) => sum + item, 0) /
      confidenceValues.length
    : 0;
  const support = clamp(rows.length / 5) * 0.45 + clamp(docs.size / 3) * 0.35;
  const span = spanDays >= 30 ? 0.2 : spanDays >= 7 ? 0.1 : 0;
  const score = clamp(support + span + avgConfidence * 0.2);

  if (rows.length === 0) {
    return {
      relationStability: 0,
      stabilityLevel: "weak",
      stabilityExplanation: "当前关系缺少 EdgeEvidence 支撑，稳定性较弱。",
    };
  }
  if (rows.length === 1 || docs.size === 1) {
    return {
      relationStability: Math.min(score, 0.55),
      stabilityLevel: "emerging",
      stabilityExplanation:
        "该关系目前主要来自单一来源，属于新出现或待验证关系。",
    };
  }
  if (score >= 0.72) {
    return {
      relationStability: score,
      stabilityLevel: "stable",
      stabilityExplanation: "该关系有多条证据和多个来源支撑，稳定性较高。",
    };
  }
  if (avgConfidence < 0.45) {
    return {
      relationStability: score,
      stabilityLevel: "unstable",
      stabilityExplanation: "该关系虽然有证据，但整体置信度偏低，需要观察。",
    };
  }
  return {
    relationStability: score,
    stabilityLevel: "weak",
    stabilityExplanation: "该关系已有一定支持，但证据密度仍不足。",
  };
}

function detectConflicts(edge = {}, siblingEdges = []) {
  const conflicts = [];
  const directionSensitive = new Set(["causes", "precedes", "part_of"]);
  for (const other of siblingEdges || []) {
    if (!other || Number(other.id) === Number(edge.id)) continue;
    const reversed =
      Number(other.sourceNodeId) === Number(edge.targetNodeId) &&
      Number(other.targetNodeId) === Number(edge.sourceNodeId);
    const samePair =
      reversed ||
      (Number(other.sourceNodeId) === Number(edge.sourceNodeId) &&
        Number(other.targetNodeId) === Number(edge.targetNodeId));
    if (!samePair) continue;

    if (
      reversed &&
      directionSensitive.has(edge.relationType) &&
      other.relationType === edge.relationType
    ) {
      conflicts.push({
        severity: "severe",
        reason: "方向敏感关系在相反方向也出现，可能存在严重冲突。",
        conflictingEdgeId: other.id,
        relationType: other.relationType,
      });
      continue;
    }
    if (other.relationType !== edge.relationType && other.confidence >= 0.65) {
      conflicts.push({
        severity: "moderate",
        reason: "同一组概念存在不同高置信关系，需要人工核对是否可并存。",
        conflictingEdgeId: other.id,
        relationType: other.relationType,
      });
      continue;
    }
    if (other.relationType !== edge.relationType) {
      conflicts.push({
        severity: "mild",
        reason: "同一组概念存在不同低置信关系，暂标记为轻度冲突。",
        conflictingEdgeId: other.id,
        relationType: other.relationType,
      });
    }
  }
  return conflicts;
}

function conflictPenalty(conflicts = []) {
  if (conflicts.some((item) => item.severity === "severe")) return 0.8;
  if (conflicts.some((item) => item.severity === "moderate")) return 0.45;
  if (conflicts.some((item) => item.severity === "mild")) return 0.18;
  return 0;
}

function driftSummary({ evidenceRows = [], conflicts = [] } = {}) {
  const rows = [...(evidenceRows || [])].sort(
    (a, b) =>
      safeDate(a.createdAt)?.getTime() - safeDate(b.createdAt)?.getTime()
  );
  const first = rows.slice(0, Math.max(1, Math.ceil(rows.length / 2)));
  const recent = rows.slice(Math.floor(rows.length / 2));
  const avg = (items) =>
    items.length
      ? items.reduce((sum, row) => sum + Number(row.confidence || 0), 0) /
        items.length
      : 0;
  const confidenceDelta = avg(recent) - avg(first);
  const confidenceTrend =
    confidenceDelta < -0.15 ? "down" : confidenceDelta > 0.15 ? "up" : "flat";
  const conflictTrend = conflicts.length ? "watch" : "none";
  const supportTrend =
    rows.length >= 3 ? "supported" : rows.length > 0 ? "thin" : "none";
  const driftLevel =
    confidenceTrend === "down" && conflicts.length
      ? "degrading"
      : confidenceTrend === "down" || conflicts.length
        ? "watch"
        : "none";
  return {
    confidenceTrend,
    conflictTrend,
    supportTrend,
    driftLevel,
    explanation:
      driftLevel === "degrading"
        ? "近期置信度下降且存在冲突，需要观察 evidence drift。"
        : driftLevel === "watch"
          ? "关系证据存在轻微漂移信号，建议后续继续观察。"
          : "当前未观察到明显 evidence drift。",
  };
}

function clusterEvidenceText(text = "") {
  const lower = String(text || "").toLowerCase();
  if (/define|definition|called|refers to|是指|定义|称为/.test(lower))
    return "definition";
  if (/mechanism|regulat|cause|pathway|process|导致|调控|机制|过程/.test(lower))
    return "mechanism";
  if (/structure|domain|region|component|part of|结构|组成|区域/.test(lower))
    return "structure";
  if (/history|evolution|origin|previous|时间|历史|演化|早期/.test(lower))
    return "history";
  if (/contrast|whereas|compared|different|similar|对比|不同|相似/.test(lower))
    return "comparison";
  if (/used|application|clinical|method|tool|应用|用于|方法/.test(lower))
    return "application";
  return "other";
}

function splitSentences(text = "") {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?。！？])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractSnippet({
  evidenceSnippet = "",
  chunkText = "",
  terms = [],
  maxSentences = 3,
} = {}) {
  const cleanEvidence = String(evidenceSnippet || "").trim();
  const cleanChunk = String(chunkText || "").trim();
  const highlightTerms = [...new Set(terms.filter(Boolean).map(String))].slice(
    0,
    8
  );

  if (cleanEvidence) {
    const anchorOffset = cleanChunk
      ? cleanChunk
          .toLowerCase()
          .indexOf(cleanEvidence.toLowerCase().slice(0, 80))
      : -1;
    return {
      snippet: cleanEvidence.slice(0, 1_200),
      contextBefore: "",
      contextAfter: "",
      fullChunk: cleanChunk,
      highlightTerms,
      anchorOffset: Math.max(0, anchorOffset),
    };
  }

  const sentences = splitSentences(cleanChunk);
  if (!sentences.length) {
    return {
      snippet: "",
      contextBefore: "",
      contextAfter: "",
      fullChunk: cleanChunk,
      highlightTerms,
      anchorOffset: 0,
    };
  }

  const lowerTerms = highlightTerms.map((term) => term.toLowerCase());
  let index = sentences.findIndex((sentence) =>
    lowerTerms.some((term) => sentence.toLowerCase().includes(term))
  );
  if (index < 0) index = 0;
  const start = Math.max(0, index - 1);
  const end = Math.min(sentences.length, start + maxSentences);
  const snippet = sentences.slice(start, end).join(" ");
  return {
    snippet,
    contextBefore: sentences.slice(Math.max(0, start - 2), start).join(" "),
    contextAfter: sentences
      .slice(end, Math.min(sentences.length, end + 2))
      .join(" "),
    fullChunk: cleanChunk,
    highlightTerms,
    anchorOffset: cleanChunk.indexOf(sentences[index]),
  };
}

function scoreEvidence({
  confidence = 0,
  relationWeight = 1,
  conceptImportance: importance = 0,
  freshness = 0.35,
  multiSourceSupport = 0,
  chunkQuality = 0,
  sourceAuthority = 0,
  relationStability = 0,
  conflictPenalty: penalty = 0,
} = {}) {
  const normalizedWeight = clamp(Number(relationWeight || 1) / 5);
  const rankScore = clamp(
    confidence * 0.28 +
      normalizedWeight * 0.17 +
      importance * 0.12 +
      freshness * 0.08 +
      multiSourceSupport * 0.1 +
      chunkQuality * 0.1 +
      sourceAuthority * 0.15
  );
  const trustScore = clamp(
    confidence * 0.24 +
      multiSourceSupport * 0.18 +
      relationStability * 0.22 +
      chunkQuality * 0.14 +
      sourceAuthority * 0.14 -
      penalty * 0.08
  );
  const trustLevel =
    trustScore >= 0.72 ? "high" : trustScore >= 0.48 ? "medium" : "low";
  return {
    rankScore,
    trustScore,
    trustLevel,
    trustBreakdown: {
      confidence: clamp(confidence),
      relationWeight: normalizedWeight,
      conceptImportance: clamp(importance),
      freshness: clamp(freshness),
      multiSourceSupport: clamp(multiSourceSupport),
      chunkQuality: clamp(chunkQuality),
      sourceAuthority: clamp(sourceAuthority),
      relationStability: clamp(relationStability),
      conflictPenalty: clamp(penalty),
    },
    trustReasons: trustReasons({
      confidence,
      multiSourceSupport,
      relationStability,
      chunkQuality,
      sourceAuthority,
      penalty,
      trustLevel,
    }),
  };
}

function trustReasons({
  confidence = 0,
  multiSourceSupport = 0,
  relationStability = 0,
  chunkQuality = 0,
  sourceAuthority = 0,
  penalty = 0,
  trustLevel = "low",
} = {}) {
  const reasons = [];
  if (confidence >= 0.7) reasons.push("关系抽取置信度较高。");
  else if (confidence < 0.45) reasons.push("关系抽取置信度偏低。");
  if (multiSourceSupport >= 0.6)
    reasons.push("存在多个来源或多条 evidence 支持。");
  else reasons.push("来源支持仍较薄，需要更多文档验证。");
  if (relationStability >= 0.7) reasons.push("关系稳定性较高。");
  if (chunkQuality >= 0.7) reasons.push("原始 chunk 文本较完整。");
  if (sourceAuthority >= 0.65) reasons.push("来源质量评分较高。");
  if (penalty > 0) reasons.push("检测到潜在冲突，已降低可信度。");
  if (trustLevel === "high") reasons.unshift("综合评分为高可信。");
  if (trustLevel === "low") reasons.unshift("综合评分为低可信，建议查看原文。");
  return reasons;
}

function whyThisEvidence({
  score = {},
  evidenceCount = 0,
  documentCount = 0,
  relationWeight = 0,
} = {}) {
  if (score.trustScore >= 0.72)
    return "这条 evidence 置信度、来源质量和关系稳定性综合较高。";
  if (documentCount > 1) return "这条 evidence 有多个文档来源共同支撑。";
  if (relationWeight > 1)
    return "这条 evidence 所属关系被多次引用或多次抽取到。";
  if (evidenceCount === 1)
    return "这是当前可用的直接原文证据，仍建议结合更多来源。";
  return "这条 evidence 与当前概念或关系最接近。";
}

function whyNoEvidence({ total = 0, filtered = null, weak = false } = {}) {
  if (total === 0) {
    return {
      status: "none",
      reasons: [
        "缺少 EdgeEvidence",
        "chunk 文本可能不可恢复或尚未完成 backfill",
      ],
      recommendedAction: "运行 Knowledge Graph backfill 或上传更多相关文档。",
    };
  }
  if (filtered !== null && total > filtered) {
    return {
      status: "filtered",
      reasons: ["部分 evidence 被分页、排序或 cluster 过滤隐藏。"],
      recommendedAction: "调整筛选条件或翻页查看更多 evidence。",
    };
  }
  if (weak) {
    return {
      status: "weak",
      reasons: ["只有单一来源或低置信度 evidence", "缺少稳定的多来源支持"],
      recommendedAction:
        "查看原始 chunk，或补充更多高质量文档后重新 backfill。",
    };
  }
  return null;
}

async function loadDocuments(workspaceId, documentIds = []) {
  const unique = [...new Set(documentIds.filter(Boolean).map(String))];
  if (!unique.length) return new Map();
  const rows = await knowledgeGraphDb.workspace_documents.findMany({
    where: {
      workspaceId: Number(workspaceId),
      docId: { in: unique },
    },
  });
  return new Map(rows.map((row) => [row.docId, row]));
}

async function loadChunkText({ document, chunkId, chunkCache }) {
  if (!document?.docId || !chunkId) return "";
  if (!chunkCache.has(document.docId)) {
    chunkCache.set(document.docId, await chunksForDocument(document));
  }
  const chunks = chunkCache.get(document.docId) || [];
  return chunks.find((chunk) => chunk.chunkId === chunkId)?.text || "";
}

async function documentCoverage(workspaceId, documentIds = []) {
  const unique = [...new Set(documentIds.filter(Boolean).map(String))];
  const coverage = new Map();
  for (const documentId of unique) {
    const [vectors, mapped] = await Promise.all([
      knowledgeGraphDb.$queryRawUnsafe(
        `SELECT COUNT(*) AS count FROM "document_vectors" WHERE "docId" = ?`,
        documentId
      ),
      knowledgeGraphDb.$queryRawUnsafe(
        `SELECT COUNT(DISTINCT "chunkId") AS count
        FROM "ConceptChunkMap"
        WHERE "workspaceId" = ? AND "documentId" = ?`,
        Number(workspaceId),
        documentId
      ),
    ]);
    coverage.set(
      documentId,
      Number(vectors?.[0]?.count || 0)
        ? Number(mapped?.[0]?.count || 0) / Number(vectors?.[0]?.count || 0)
        : 0
    );
  }
  return coverage;
}

async function siblingEdgesFor(edge) {
  return await knowledgeGraphDb.$queryRawUnsafe(
    `SELECT * FROM "KnowledgeEdge"
    WHERE "workspaceId" = ?
      AND (
        ("sourceNodeId" = ? AND "targetNodeId" = ?)
        OR ("sourceNodeId" = ? AND "targetNodeId" = ?)
      )`,
    Number(edge.workspaceId),
    Number(edge.sourceNodeId),
    Number(edge.targetNodeId),
    Number(edge.targetNodeId),
    Number(edge.sourceNodeId)
  );
}

async function edgeRowsByIds(workspaceId, edgeIds = []) {
  const ids = [...new Set(edgeIds.map(Number).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await knowledgeGraphDb.$queryRawUnsafe(
    `SELECT e.*, s."canonicalName" AS "sourceName", s."displayNameZh" AS "sourceZh",
      s."displayNameEn" AS "sourceEn", s."aliases" AS "sourceAliases",
      s."entityType" AS "sourceType", s."globalImportanceScore" AS "sourceGlobal",
      s."workspaceImportanceScore" AS "sourceWorkspace", s."recentImportanceScore" AS "sourceRecent",
      t."canonicalName" AS "targetName", t."displayNameZh" AS "targetZh",
      t."displayNameEn" AS "targetEn", t."aliases" AS "targetAliases",
      t."entityType" AS "targetType", t."globalImportanceScore" AS "targetGlobal",
      t."workspaceImportanceScore" AS "targetWorkspace", t."recentImportanceScore" AS "targetRecent"
    FROM "KnowledgeEdge" e
    JOIN "KnowledgeNode" s ON s."id" = e."sourceNodeId"
    JOIN "KnowledgeNode" t ON t."id" = e."targetNodeId"
    WHERE e."workspaceId" = ? AND e."id" IN (${ids.map(() => "?").join(",")})`,
    Number(workspaceId),
    ...ids
  );
  return new Map(rows.map((row) => [Number(row.id), hydrateEdgeRow(row)]));
}

function hydrateEdgeRow(row = {}) {
  return {
    ...row,
    source: displayConcept({
      id: row.sourceNodeId,
      canonicalName: row.sourceName,
      displayNameZh: row.sourceZh,
      displayNameEn: row.sourceEn,
      aliases: row.sourceAliases,
      entityType: row.sourceType,
      globalImportanceScore: row.sourceGlobal,
      workspaceImportanceScore: row.sourceWorkspace,
      recentImportanceScore: row.sourceRecent,
    }),
    target: displayConcept({
      id: row.targetNodeId,
      canonicalName: row.targetName,
      displayNameZh: row.targetZh,
      displayNameEn: row.targetEn,
      aliases: row.targetAliases,
      entityType: row.targetType,
      globalImportanceScore: row.targetGlobal,
      workspaceImportanceScore: row.targetWorkspace,
      recentImportanceScore: row.targetRecent,
    }),
  };
}

async function enrichEvidenceRows({
  workspaceId,
  evidenceRows = [],
  edgeById = new Map(),
  node = null,
}) {
  const documents = await loadDocuments(
    workspaceId,
    evidenceRows.map((row) => row.documentId)
  );
  const coverage = await documentCoverage(
    workspaceId,
    evidenceRows.map((row) => row.documentId)
  );
  const chunkCache = new Map();
  const byEdge = new Map();
  for (const row of evidenceRows) {
    byEdge.set(row.edgeId, [...(byEdge.get(row.edgeId) || []), row]);
  }

  const items = [];
  for (const row of evidenceRows) {
    const edge = edgeById.get(Number(row.edgeId));
    const document = documents.get(row.documentId);
    const chunkText = await loadChunkText({
      document,
      chunkId: row.chunkId,
      chunkCache,
    });
    const terms = [
      node?.canonicalName,
      edge?.source?.canonicalName,
      edge?.source?.displayNameZh,
      edge?.target?.canonicalName,
      edge?.target?.displayNameZh,
      edge?.relationLabel,
      edge?.relationLabelZh,
      edge?.relationType,
    ].filter(Boolean);
    const snippet = extractSnippet({
      evidenceSnippet: row.snippet,
      chunkText,
      terms,
    });
    const sourceAuthority = sourceAuthorityScore({
      document,
      chunkText,
      coverage: coverage.get(row.documentId) || 0,
    });
    const stability = relationStability(byEdge.get(row.edgeId) || []);
    const siblings = edge ? await siblingEdgesFor(edge) : [];
    const conflicts = edge ? detectConflicts(edge, siblings) : [];
    const score = scoreEvidence({
      confidence: Number(row.confidence || edge?.confidence || 0),
      relationWeight: Number(edge?.weight || 1),
      conceptImportance: node
        ? conceptImportance(node)
        : conceptImportance(edge?.source, edge?.target),
      freshness: freshnessScore(row.createdAt),
      multiSourceSupport: clamp(
        new Set((byEdge.get(row.edgeId) || []).map((item) => item.documentId))
          .size / 3
      ),
      chunkQuality: chunkQualityScore({
        chunkText,
        snippet: snippet.snippet,
      }),
      sourceAuthority: sourceAuthority.sourceAuthority,
      relationStability: stability.relationStability,
      conflictPenalty: conflictPenalty(conflicts),
    });
    const cluster = clusterEvidenceText(
      `${snippet.snippet} ${edge?.relationType || ""} ${edge?.relationLabel || ""}`
    );
    items.push({
      id: row.id,
      edgeId: row.edgeId,
      documentId: row.documentId,
      chunkId: row.chunkId,
      document: document
        ? {
            id: document.id,
            docId: document.docId,
            filename: document.filename,
            docpath: document.docpath,
            pinned: !!document.pinned,
            watched: !!document.watched,
            createdAt: document.createdAt,
          }
        : null,
      relation: edge
        ? {
            id: edge.id,
            sourceConcept: edge.source,
            targetConcept: edge.target,
            relationType: edge.relationType,
            relationLabel: edge.relationLabel,
            relationLabelZh: edge.relationLabelZh,
            relationLabelEn: edge.relationLabelEn,
            confidence: Number(edge.confidence || 0),
            weight: Number(edge.weight || 0),
          }
        : null,
      confidence: Number(row.confidence || edge?.confidence || 0),
      createdAt: row.createdAt,
      cluster,
      clusterLabel: CLUSTERS[cluster] || CLUSTERS.other,
      snippet: snippet.snippet,
      contextBefore: snippet.contextBefore,
      contextAfter: snippet.contextAfter,
      fullChunk: snippet.fullChunk,
      highlightTerms: snippet.highlightTerms,
      anchorOffset: snippet.anchorOffset,
      ...score,
      ...stability,
      ...sourceAuthority,
      conflicts,
      drift: driftSummary({
        evidenceRows: byEdge.get(row.edgeId) || [],
        conflicts,
      }),
      whyThisEvidence: whyThisEvidence({
        score,
        evidenceCount: (byEdge.get(row.edgeId) || []).length,
        documentCount: new Set(
          (byEdge.get(row.edgeId) || []).map((item) => item.documentId)
        ).size,
        relationWeight: Number(edge?.weight || 0),
      }),
    });
  }
  return items;
}

function applySort(items = [], sort = "trust") {
  const copy = [...items];
  if (sort === "timeline") {
    return copy.sort(
      (a, b) =>
        (safeDate(b.createdAt)?.getTime() || 0) -
        (safeDate(a.createdAt)?.getTime() || 0)
    );
  }
  if (sort === "rank") {
    return copy.sort((a, b) => b.rankScore - a.rankScore);
  }
  return copy.sort((a, b) => b.trustScore - a.trustScore);
}

function paginate(items = [], page = 1, limit = DEFAULT_LIMIT) {
  const safeLimit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(limit || DEFAULT_LIMIT))
  );
  const safePage = Math.max(1, Number(page || 1));
  const offset = (safePage - 1) * safeLimit;
  return {
    items: items.slice(offset, offset + safeLimit),
    pagination: {
      page: safePage,
      limit: safeLimit,
      total: items.length,
      totalPages: Math.max(1, Math.ceil(items.length / safeLimit)),
    },
  };
}

function clusterSummary(items = []) {
  return Object.entries(CLUSTERS).map(([key, label]) => ({
    key,
    label,
    count: items.filter((item) => item.cluster === key).length,
  }));
}

async function edgeEvidence({
  workspaceId,
  edgeId,
  page = 1,
  limit = DEFAULT_LIMIT,
  sort = "trust",
  cluster = "",
}) {
  await KnowledgeGraph.ensureTables();
  const edgeMap = await edgeRowsByIds(workspaceId, [edgeId]);
  const edge = edgeMap.get(Number(edgeId));
  if (!edge) return null;
  const evidenceRows = await knowledgeGraphDb.$queryRawUnsafe(
    `SELECT * FROM "EdgeEvidence"
    WHERE "workspaceId" = ? AND "edgeId" = ?
    ORDER BY "createdAt" DESC`,
    Number(workspaceId),
    Number(edgeId)
  );
  const conflicts = detectConflicts(edge, await siblingEdgesFor(edge));
  const enriched = await enrichEvidenceRows({
    workspaceId,
    evidenceRows,
    edgeById: edgeMap,
  });
  const filtered = cluster
    ? enriched.filter((item) => item.cluster === cluster)
    : enriched;
  const sorted = applySort(filtered, sort);
  const paged = paginate(sorted, page, limit);
  const stability = relationStability(evidenceRows);
  const drift = driftSummary({ evidenceRows, conflicts });
  const avgTrust = enriched.length
    ? enriched.reduce((sum, item) => sum + item.trustScore, 0) / enriched.length
    : 0;
  return {
    targetType: "edge",
    targetId: String(edgeId),
    edge: {
      id: edge.id,
      sourceConcept: edge.source,
      targetConcept: edge.target,
      relationType: edge.relationType,
      relationLabel: edge.relationLabel,
      relationLabelZh: edge.relationLabelZh,
      relationLabelEn: edge.relationLabelEn,
      confidence: Number(edge.confidence || 0),
      weight: Number(edge.weight || 0),
    },
    evidence: paged.items,
    pagination: paged.pagination,
    clusters: clusterSummary(enriched),
    conflicts,
    drift,
    ...stability,
    trustScore: clamp(avgTrust),
    trustLevel: avgTrust >= 0.72 ? "high" : avgTrust >= 0.48 ? "medium" : "low",
    whyNoEvidence: whyNoEvidence({
      total: evidenceRows.length,
      filtered: filtered.length,
      weak: evidenceRows.length > 0 && avgTrust < 0.45,
    }),
  };
}

async function nodeEvidence({
  workspaceId,
  nodeId = null,
  concept = "",
  page = 1,
  limit = DEFAULT_LIMIT,
  sort = "trust",
  cluster = "",
}) {
  await KnowledgeGraph.ensureTables();
  const node = nodeId
    ? await KnowledgeGraph.getNode(Number(nodeId))
    : await KnowledgeGraph.findNodeByNameOrAlias({
        workspaceId,
        name: concept,
      });
  if (!node) return null;

  const relationRows = await knowledgeGraphDb.$queryRawUnsafe(
    `SELECT * FROM "KnowledgeEdge"
    WHERE "workspaceId" = ? AND ("sourceNodeId" = ? OR "targetNodeId" = ?)`,
    Number(workspaceId),
    Number(node.id),
    Number(node.id)
  );
  const edgeIds = relationRows.map((row) => Number(row.id));
  const edgeMap = await edgeRowsByIds(workspaceId, edgeIds);
  const evidenceRows = edgeIds.length
    ? await knowledgeGraphDb.$queryRawUnsafe(
        `SELECT ev.* FROM "EdgeEvidence" ev
        WHERE ev."workspaceId" = ?
          AND ev."edgeId" IN (${edgeIds.map(() => "?").join(",")})
        ORDER BY ev."createdAt" DESC`,
        Number(workspaceId),
        ...edgeIds
      )
    : [];
  const enriched = await enrichEvidenceRows({
    workspaceId,
    evidenceRows,
    edgeById: edgeMap,
    node,
  });
  const filtered = cluster
    ? enriched.filter((item) => item.cluster === cluster)
    : enriched;
  const sorted = applySort(filtered, sort);
  const paged = paginate(sorted, page, limit);
  const relatedChunks = await knowledgeGraphDb.$queryRawUnsafe(
    `SELECT c.*, d."filename", d."docpath"
    FROM "ConceptChunkMap" c
    LEFT JOIN "workspace_documents" d
      ON d."workspaceId" = c."workspaceId" AND d."docId" = c."documentId"
    WHERE c."workspaceId" = ? AND c."nodeId" = ?
    ORDER BY c."relevanceScore" DESC, c."mentionCount" DESC
    LIMIT 25`,
    Number(workspaceId),
    Number(node.id)
  );
  const documents = [
    ...new Map(
      evidenceRows.map((row) => [
        row.documentId,
        {
          documentId: row.documentId,
          evidenceCount: evidenceRows.filter(
            (item) => item.documentId === row.documentId
          ).length,
        },
      ])
    ).values(),
  ];
  const avgTrust = enriched.length
    ? enriched.reduce((sum, item) => sum + item.trustScore, 0) / enriched.length
    : 0;
  return {
    targetType: "node",
    targetId: String(node.id),
    concept: displayConcept(node),
    aliases: node.aliases || [],
    documents,
    relatedChunks: relatedChunks.map((row) => ({
      documentId: row.documentId,
      chunkId: row.chunkId,
      relevanceScore: Number(row.relevanceScore || 0),
      mentionCount: Number(row.mentionCount || 0),
      title: row.filename,
      path: row.docpath,
    })),
    relationCount: relationRows.length,
    importanceScores: {
      global: Number(node.globalImportanceScore || 0),
      workspace: Number(node.workspaceImportanceScore || 0),
      recent: Number(node.recentImportanceScore || 0),
    },
    evidence: paged.items,
    pagination: paged.pagination,
    clusters: clusterSummary(enriched),
    trustScore: clamp(avgTrust),
    trustLevel: avgTrust >= 0.72 ? "high" : avgTrust >= 0.48 ? "medium" : "low",
    whyNoEvidence: whyNoEvidence({
      total: evidenceRows.length,
      filtered: filtered.length,
      weak: evidenceRows.length > 0 && avgTrust < 0.45,
    }),
  };
}

module.exports = {
  nodeEvidence,
  edgeEvidence,
  extractSnippet,
  scoreEvidence,
  relationStability,
  detectConflicts,
  driftSummary,
  clusterEvidenceText,
  whyNoEvidence,
  sourceAuthorityScore,
};
