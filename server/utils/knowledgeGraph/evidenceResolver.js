const prisma = require("../prisma");
const { chunksForDocument } = require("./chunks");

async function loadDocuments(workspaceId, documentIds = []) {
  const unique = [...new Set(documentIds.filter(Boolean).map(String))];
  if (!unique.length) return new Map();
  const docs = await prisma.workspace_documents.findMany({
    where: { workspaceId: Number(workspaceId), docId: { in: unique } },
  });
  return new Map(docs.map((doc) => [doc.docId, doc]));
}

async function chunksFromRows({
  workspaceId,
  rows = [],
  sourceType = "original",
}) {
  const documents = await loadDocuments(
    workspaceId,
    rows.map((row) => row.documentId)
  );
  const cache = new Map();
  const out = [];
  for (const row of rows) {
    const document = documents.get(row.documentId);
    if (!document) continue;
    if (!cache.has(document.docId))
      cache.set(document.docId, await chunksForDocument(document));
    const chunk = cache
      .get(document.docId)
      .find((item) => item.chunkId === row.chunkId);
    if (!chunk?.text) continue;
    out.push({
      ...chunk,
      evidenceType: row.evidenceType || sourceType,
      sourceType,
      relevanceScore: Number(row.relevanceScore || row.confidence || 0),
      score: Number(row.relevanceScore || row.confidence || 0),
      title: document.filename || document.docpath,
    });
  }
  return out;
}

async function originalEvidenceChunks({
  workspaceId,
  node,
  nodeKey,
  limit = 5,
}) {
  if (!workspaceId || (!node?.id && !nodeKey)) return [];
  const bindingRows = nodeKey
    ? await prisma
        .$queryRawUnsafe(
          `SELECT * FROM "NodeChunkBinding"
        WHERE "workspaceId" = ? AND "nodeKey" = ?
        ORDER BY "relevanceScore" DESC, "updatedAt" DESC
        LIMIT ?`,
          Number(workspaceId),
          String(nodeKey),
          Number(limit || 5)
        )
        .catch(() => [])
    : [];
  if (bindingRows.length) {
    return await chunksFromRows({
      workspaceId,
      rows: bindingRows,
      sourceType: "node_chunk_binding",
    });
  }
  if (!node?.id) return [];
  const conceptRows = await prisma
    .$queryRawUnsafe(
      `SELECT *, 'original' AS "evidenceType"
    FROM "ConceptChunkMap"
    WHERE "workspaceId" = ? AND "nodeId" = ?
    ORDER BY "relevanceScore" DESC, "mentionCount" DESC
    LIMIT ?`,
      Number(workspaceId),
      Number(node.id),
      Number(limit || 5)
    )
    .catch(() => []);
  return await chunksFromRows({
    workspaceId,
    rows: conceptRows,
    sourceType: "node_original",
  });
}

function sourceRefForChunk(chunk = {}, index = 0) {
  return {
    id: `graph-context-${index + 1}`,
    title: chunk.title || chunk.document?.filename || "Source",
    docId: chunk.documentId || chunk.document?.docId || null,
    docpath: chunk.document?.docpath || null,
    chunkId: chunk.chunkId || null,
    score: chunk.score ?? chunk.relevanceScore ?? 0,
    sourceType: chunk.sourceType || chunk.evidenceType || null,
    nodeKey: chunk.nodeKey || null,
    nodeLabel: chunk.nodeLabel || null,
  };
}

module.exports = {
  originalEvidenceChunks,
  sourceRefForChunk,
};
