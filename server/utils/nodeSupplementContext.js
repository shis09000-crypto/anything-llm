const prisma = require("./prisma");
const { NodeSupplement } = require("../models/nodeSupplement");
const { chunksForDocument } = require("./knowledgeGraph/chunks");

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

function chunkScore(chunk = {}, terms = []) {
  const text = String(chunk.text || "").toLowerCase();
  if (!text || terms.length === 0) return 0;
  return terms.reduce(
    (score, term) => score + (text.includes(term) ? 1 : 0),
    0
  );
}

function sourceRefFor({ supplement, chunk, index, score }) {
  return {
    id: `node-supplement-${index + 1}`,
    title:
      supplement.documentName || chunk.document?.filename || "Node Supplement",
    docId: supplement.documentId,
    docpath: chunk.document?.docpath || null,
    chunkId: chunk.chunkId || null,
    score,
    nodeKey: supplement.nodeKey,
    nodeLabel: supplement.nodeLabel,
    sourceType: "node_supplement",
  };
}

async function retrieveNodeSupplementContext({
  workspace,
  nodeContext = null,
  query = "",
  limit = 4,
}) {
  const nodeKey = String(nodeContext?.nodeKey || "").trim();
  if (!workspace?.id || !nodeKey) return { contextTexts: [], sources: [] };

  const supplements = await NodeSupplement.list({
    workspaceId: workspace.id,
    nodeKey,
  });
  if (supplements.length === 0) return { contextTexts: [], sources: [] };

  const documents = await prisma.workspace_documents.findMany({
    where: {
      workspaceId: Number(workspace.id),
      docId: { in: supplements.map((item) => item.documentId) },
    },
  });
  const documentById = new Map(documents.map((doc) => [doc.docId, doc]));
  const terms = tokenize(
    `${nodeContext?.nodeLabel || ""} ${nodeContext?.nodeType || ""} ${query}`
  );
  const ranked = [];

  for (const supplement of supplements) {
    const document = documentById.get(supplement.documentId);
    if (!document) continue;
    const chunks = await chunksForDocument(document);
    for (const chunk of chunks) {
      const score =
        chunkScore(chunk, terms) + Number(supplement.priority || 0) / 100;
      ranked.push({ supplement, chunk, score });
    }
  }

  const selected = ranked
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Number(limit || 4)));

  return {
    contextTexts: selected.map(
      ({ supplement, chunk }) =>
        `[节点补充: ${supplement.nodeLabel} / ${supplement.documentName}]\n${chunk.text}`
    ),
    sources: selected.map(({ supplement, chunk, score }, index) => ({
      text: chunk.text,
      ...sourceRefFor({ supplement, chunk, index, score }),
    })),
  };
}

module.exports = {
  retrieveNodeSupplementContext,
  tokenize,
};
