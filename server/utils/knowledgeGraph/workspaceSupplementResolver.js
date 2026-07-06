const {
  lazyDataAccessFacade,
  lazyDataAccessProperty,
} = require("../dataAccess/lazyFacade");
const KnowledgeGraphData = lazyDataAccessFacade("knowledgeGraph");
const knowledgeGraphDb = KnowledgeGraphData.db;
const WorkspaceSupplement = lazyDataAccessProperty(
  "knowledgeGraph",
  "workspaceSupplement"
);
const { isHighStructureSupplement } = require("./supplementConstants");

function fileHelpers() {
  return require("../files");
}

async function workspaceSupplementsWithContent({
  workspaceId,
  scopeType = null,
  limit = 12,
} = {}) {
  const supplements = await WorkspaceSupplement.weighted({
    workspaceId,
    scopeType,
    limit,
  }).catch(() => []);
  if (!supplements.length) return [];
  const docs = await knowledgeGraphDb.workspace_documents.findMany({
    where: {
      workspaceId: Number(workspaceId),
      docId: { in: supplements.map((item) => item.documentId) },
    },
  });
  const docsById = new Map(docs.map((doc) => [doc.docId, doc]));
  const { fileData } = fileHelpers();
  const enriched = [];
  for (const supplement of supplements) {
    const doc = docsById.get(supplement.documentId);
    const data = doc ? await fileData(doc.docpath).catch(() => null) : null;
    enriched.push({
      ...supplement,
      document: doc || null,
      parsedStructure: supplement.metadata?.parsedStructure || null,
      structureJsonValid:
        supplement.metadata?.structureJsonValidation?.valid === true,
      highStructureValue: isHighStructureSupplement(supplement.supplementKind),
      text: String(data?.pageContent || "").slice(0, 18_000),
    });
  }
  return enriched;
}

function supplementSignalText(supplements = []) {
  return supplements
    .map((item) => {
      const parsed = item.parsedStructure
        ? JSON.stringify(item.parsedStructure)
        : "";
      return [
        `supplementKind=${item.supplementKind}`,
        `weight=${item.weight}`,
        parsed,
        item.text,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

module.exports = {
  workspaceSupplementsWithContent,
  supplementSignalText,
};
