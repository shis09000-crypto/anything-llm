const {
  lazyDataAccessFacade,
  lazyDataAccessProperty,
} = require("../dataAccess/lazyFacade");
const KnowledgeGraphData = lazyDataAccessFacade("knowledgeGraph");
const knowledgeGraphDb = KnowledgeGraphData.db;
const { chunksForDocument } = require("./chunks");
const NodeSupplement = lazyDataAccessProperty(
  "knowledgeGraph",
  "nodeSupplement"
);

function tokenize(value = "") {
  return [
    ...new Set(
      String(value || "")
        .toLowerCase()
        .split(/[\s,，。.;；:：!?！？、"'“”‘’()[\]{}<>《》]+/)
        .map((item) => item.trim())
        .filter((item) => item.length >= 2)
    ),
  ];
}

function scoreChunk(chunk = {}, terms = []) {
  const text = String(chunk.text || "").toLowerCase();
  return terms.reduce(
    (score, term) => score + (text.includes(term) ? 1 : 0),
    0
  );
}

async function supplementChunks({
  workspace,
  node,
  nodeKey,
  query = "",
  limit = 4,
} = {}) {
  const key = node?.nodeKey || nodeKey;
  if (!workspace?.id || !key) return { supplements: [], chunks: [] };
  const supplements = await NodeSupplement.list({
    workspaceId: workspace.id,
    nodeKey: key,
  });
  if (!supplements.length) return { supplements, chunks: [] };
  const documents = await knowledgeGraphDb.workspace_documents.findMany({
    where: {
      workspaceId: Number(workspace.id),
      docId: { in: supplements.map((item) => item.documentId) },
    },
  });
  const docById = new Map(documents.map((doc) => [doc.docId, doc]));
  const terms = tokenize(
    `${node?.canonicalName || ""} ${node?.displayNameZh || ""} ${query}`
  );
  const ranked = [];
  for (const supplement of supplements) {
    const document = docById.get(supplement.documentId);
    if (!document) continue;
    const chunks = await chunksForDocument(document);
    for (const chunk of chunks) {
      ranked.push({
        ...chunk,
        evidenceType: "supplement",
        sourceType: "node_supplement",
        nodeKey: key,
        nodeLabel: supplement.nodeLabel,
        title: supplement.documentName,
        score:
          scoreChunk(chunk, terms) + Number(supplement.priority || 0) / 100,
      });
    }
  }
  return {
    supplements,
    chunks: ranked
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, Number(limit || 4))),
  };
}

module.exports = {
  supplementChunks,
  tokenize,
};
