const workspaceDocumentSelect = Object.freeze({
  id: true,
  docId: true,
  filename: true,
  pinned: true,
  watched: true,
  embeddingStatus: true,
  embeddingError: true,
  embeddingBatchJobId: true,
});

function workspaceDocumentProjection(document = {}) {
  return {
    id: document.id,
    docId: document.docId,
    filename: document.filename,
    pinned: Boolean(document.pinned),
    watched: Boolean(document.watched),
    embeddingStatus: document.embeddingStatus,
    embeddingError: document.embeddingError || null,
    embeddingBatchJobId: document.embeddingBatchJobId || null,
  };
}

async function workspaceDocumentsProjection(client, workspaceId) {
  const documents = await client.workspace_documents.findMany({
    where: { workspaceId: Number(workspaceId) },
    select: workspaceDocumentSelect,
    orderBy: { id: "asc" },
  });
  return documents.map(workspaceDocumentProjection);
}

module.exports = {
  workspaceDocumentProjection,
  workspaceDocumentSelect,
  workspaceDocumentsProjection,
};
