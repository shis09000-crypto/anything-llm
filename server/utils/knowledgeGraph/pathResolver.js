const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const KnowledgeGraphData = lazyDataAccessFacade("knowledgeGraph");
const knowledgeGraphDb = KnowledgeGraphData.db;
const { relatedNodes } = require("./nodeResolver");

function pathTypeFor({ profile, bookStructure, workspaceSupplements = [] }) {
  const highKinds = new Set(
    workspaceSupplements
      .filter((item) => Number(item.weight || 0) >= 60)
      .map((item) => item.supplementKind)
  );
  if (profile?.profileType !== "book") {
    if (profile?.profileType === "project") return "project_decision_path";
    if (profile?.profileType === "research") return "research_thread_path";
    if (highKinds.has("concept_index")) return "idea_cluster_path";
    return "idea_cluster_path";
  }
  if (highKinds.has("timeline")) return "historical_lineage";
  if (highKinds.has("concept_index")) return "conceptual_development";
  if (highKinds.has("person_map")) return "influence_chain";
  switch (bookStructure?.structureType) {
    case "person_driven":
      return "influence_chain";
    case "concept_driven":
      return "conceptual_development";
    case "chronology_driven":
      return "historical_lineage";
    case "problem_driven":
      return "unresolved_question_path";
    case "method_driven":
      return "prerequisite_path";
    case "argument_driven":
      return "evidence_to_conclusion_path";
    default:
      return "chapter_or_topic_path";
  }
}

async function keyPathsForNode({
  workspaceId,
  node,
  profile = null,
  bookStructure = null,
  workspaceSupplements = [],
  limit = 3,
} = {}) {
  if (!workspaceId || !node?.id) return [];
  const neighbors = await relatedNodes({
    workspaceId,
    nodeId: node.id,
    limit: Math.max(3, Number(limit || 3) * 3),
  });
  if (!neighbors.length) return [];
  const rows = await knowledgeGraphDb
    .$queryRawUnsafe(
      `SELECT e.*
    FROM "KnowledgeEdge" e
    WHERE e."workspaceId" = ?
      AND (e."sourceNodeId" = ? OR e."targetNodeId" = ?)
    ORDER BY e."confidence" DESC, e."weight" DESC
    LIMIT ?`,
      Number(workspaceId),
      Number(node.id),
      Number(node.id),
      Math.max(3, Number(limit || 3))
    )
    .catch(() => []);
  return rows.map((edge, index) => {
    const otherId =
      Number(edge.sourceNodeId) === Number(node.id)
        ? Number(edge.targetNodeId)
        : Number(edge.sourceNodeId);
    const other = neighbors.find((item) => Number(item.id) === otherId);
    return {
      pathId: `path-${node.id}-${edge.id}`,
      workspaceId: Number(workspaceId),
      pathType: pathTypeFor({ profile, bookStructure, workspaceSupplements }),
      nodes: [node, other].filter(Boolean),
      edges: [
        {
          id: Number(edge.id),
          relationType: edge.relationType,
          confidence: Number(edge.confidence || 0),
          weight: Number(edge.weight || 0),
        },
      ],
      learningValue: Math.round(
        Math.min(
          100,
          Number(edge.confidence || 0) * 70 + Number(edge.weight || 0) * 5
        )
      ),
      difficulty: index === 0 ? "easy" : "medium",
      evidenceRefs: [],
      summary: other
        ? `${node.displayNameZh || node.canonicalName} 与 ${other.displayNameZh || other.canonicalName} 的关键关系`
        : `${node.displayNameZh || node.canonicalName} 的关键路径`,
    };
  });
}

module.exports = {
  keyPathsForNode,
  pathTypeFor,
};
