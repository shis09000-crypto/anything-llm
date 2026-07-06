const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const KnowledgeGraphData = lazyDataAccessFacade("knowledgeGraph");
const { safeJsonParse } = require("../http");
const knowledgeGraphDb = KnowledgeGraphData.db;

function fileHelpers() {
  return require("../files");
}

function flattenCachedChunks(chunks = []) {
  return chunks.flatMap((batch) => (Array.isArray(batch) ? batch : [batch]));
}

async function vectorRowsForDocument(docId) {
  return await knowledgeGraphDb.$queryRawUnsafe(
    `SELECT * FROM "document_vectors" WHERE "docId" = ? ORDER BY "id" ASC`,
    String(docId)
  );
}

async function chunksForDocument(document = null) {
  if (!document?.docId || !document?.docpath) return [];
  const vectorRows = await vectorRowsForDocument(document.docId);
  if (vectorRows.length === 0) return [];
  const { cachedVectorInformation, fileData } = fileHelpers();
  const cache = await cachedVectorInformation(document.docpath);
  const metadata = safeJsonParse(document.metadata, {});
  const cachedChunks = cache.exists ? flattenCachedChunks(cache.chunks) : [];

  if (!cachedChunks.length) {
    const source = await fileData(document.docpath).catch(() => null);
    const fallbackChunks = splitTextForVectorRows(
      source?.pageContent || metadata.pageContent || "",
      vectorRows.length
    );
    return vectorRows
      .map((row, index) => {
        const text = fallbackChunks[index] || "";
        if (!text) return null;
        return {
          chunkId: row.vectorId,
          documentId: document.docId,
          document,
          text,
          metadata: {
            ...metadata,
            title: source?.title || metadata.title,
            text: undefined,
            graphTextSource: "document_page_content_fallback",
          },
        };
      })
      .filter(Boolean);
  }

  return vectorRows
    .map((row, index) => {
      const cached = cachedChunks[index];
      const text = cached?.metadata?.text || cached?.text || "";
      if (!text) return null;
      return {
        chunkId: row.vectorId,
        documentId: document.docId,
        document,
        text,
        metadata: {
          ...metadata,
          ...(cached?.metadata || {}),
          text: undefined,
        },
      };
    })
    .filter(Boolean);
}

async function chunkForJob(job = null) {
  if (!job?.documentId || !job?.chunkId) return null;
  const document = await knowledgeGraphDb.workspace_documents.findFirst({
    where: { docId: job.documentId, workspaceId: Number(job.workspaceId) },
  });
  const chunks = await chunksForDocument(document);
  return chunks.find((chunk) => chunk.chunkId === job.chunkId) || null;
}

function splitTextForVectorRows(text = "", count = 1) {
  const clean = String(text || "").trim();
  if (!clean || count <= 0) return [];
  if (count === 1) return [clean];
  const target = Math.ceil(clean.length / count);
  const chunks = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    if (index === count - 1) {
      chunks.push(clean.slice(cursor).trim());
      break;
    }
    let end = Math.min(clean.length, cursor + target);
    const boundary = clean.lastIndexOf("\n\n", end);
    if (boundary > cursor + target * 0.55) end = boundary;
    chunks.push(clean.slice(cursor, end).trim());
    cursor = end;
  }
  return chunks.filter(Boolean);
}

module.exports = {
  flattenCachedChunks,
  vectorRowsForDocument,
  splitTextForVectorRows,
  chunksForDocument,
  chunkForJob,
};
