export function filterGraphSchema(schema = {}, options = {}) {
  const selectedEdgeIds = new Set(
    (options.selectedPath?.edgeIds || []).map((id) => `kg-edge-${id}`)
  );
  const autoSimplified = Boolean(options.autoSimplified);
  const edges = (schema.edges || [])
    .map((edge) => ({
      ...edge,
      labelMode:
        options.labelMode === "auto"
          ? edge.labelModeDefault || "auto"
          : options.labelMode,
      isPathEdge: selectedEdgeIds.has(edge.id),
      isSelectedEdge: options.selectedEdgeId === edge.id,
    }))
    .filter((edge) => {
      if (edge.isLayoutEdge || edge.edgeRole === "layout") return true;
      if (edge.isMainEdge) return true;
      if (options.mainOnly) return edge.isMainEdge;
      if (
        (autoSimplified || options.hideWeakRelations) &&
        (edge.isWeakRelation ||
          edge.relationType === "related_to" ||
          Number(edge.confidence ?? 1) < 0.55 ||
          Number(edge.evidenceCount || 0) === 0)
      )
        return false;
      if (options.hideRelatedTo && edge.relationType === "related_to")
        return false;
      if (options.relationTypeFilter === "conflict") return edge.isConflictEdge;
      if (
        options.relationTypeFilter &&
        options.relationTypeFilter !== "all" &&
        edge.relationType !== options.relationTypeFilter
      )
        return false;
      return true;
    });
  const budgetedEdges = applyEdgeBudget(edges, autoSimplified);
  const pathNodeIds = new Set(
    (options.selectedPath?.nodeIds || []).map((id) => `kg-${id}`)
  );
  return {
    ...schema,
    edgeLabelMode:
      autoSimplified && options.labelMode === "auto"
        ? "main"
        : options.labelMode,
    nodes: (schema.nodes || []).map((node) => ({
      ...node,
      isPathNode: pathNodeIds.has(node.id),
    })),
    edges: budgetedEdges,
  };
}

function applyEdgeBudget(edges = [], autoSimplified = false) {
  const main = edges.filter((edge) => edge.isMainEdge || edge.isLayoutEdge);
  const rest = edges
    .filter((edge) => !edge.isMainEdge && !edge.isLayoutEdge)
    .sort(edgeSortScore);
  const counts = new Map();
  const kept = [...main];
  for (const edge of rest) {
    const role = edge.edgeRole || "support";
    const limit =
      role === "branch" ? 6 : role === "support" ? 4 : autoSimplified ? 0 : 2;
    const sourceCount = counts.get(edge.source) || 0;
    const targetCount = counts.get(edge.target) || 0;
    if (sourceCount >= limit || targetCount >= limit) continue;
    kept.push(edge);
    counts.set(edge.source, sourceCount + 1);
    counts.set(edge.target, targetCount + 1);
  }
  return kept;
}

function edgeSortScore(a = {}, b = {}) {
  const roleWeight = { branch: 5, support: 3, conflict: 4, weak: 1 };
  const score = (edge) =>
    (roleWeight[edge.edgeRole] || 2) * 10 +
    Number(edge.confidence || 0) * 4 +
    Math.min(3, Number(edge.weight || 0)) +
    Math.min(3, Number(edge.evidenceCount || 0)) -
    (edge.relationType === "related_to" ? 5 : 0);
  return score(b) - score(a);
}

export function defaultCollapsed(schema = {}) {
  return new Set(
    (schema.nodes || [])
      .filter((node) => node.collapsedByDefault)
      .map((node) => node.id)
  );
}

export function safeFilename(value = "mind-map") {
  return String(value || "mind-map")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function documentTitle(doc = {}) {
  return (
    doc.filename ||
    doc.title ||
    doc.name ||
    doc.docpath ||
    doc.filePath ||
    "未命名文档"
  );
}

export function documentSubtitle(doc = {}, title = "") {
  const candidate = doc.docpath || doc.filePath || doc.location || doc.type;
  if (!candidate || candidate === title) return "";
  return candidate;
}

export function formatScore(value) {
  return Number(value || 0).toFixed(2);
}

export function formatAliases(aliases = []) {
  return (Array.isArray(aliases) ? aliases : [])
    .flatMap((alias) => {
      if (alias && typeof alias === "object") {
        return [alias.zh, alias.en].filter(Boolean);
      }
      return [alias].filter(Boolean);
    })
    .map((alias) => String(alias));
}

export function parseGraphEdgeId(value = "") {
  const match = String(value || "").match(/^kg-edge-(\d+)$/);
  return match ? Number(match[1]) : null;
}

export function conceptName(concept = {}) {
  if (!concept) return "";
  return (
    concept.displayNameZh ||
    concept.displayNameEn ||
    concept.canonicalName ||
    ""
  );
}

export function trustLabel(level, score) {
  const labels = { high: "高可信", medium: "中可信", low: "低可信" };
  return `${labels[level] || "待评估"} ${formatScore(score)}`;
}

export function driftLabel(level) {
  const labels = {
    none: "稳定",
    watch: "观察",
    degrading: "下降",
  };
  return labels[level] || "无";
}

export function stabilityLabel(level) {
  const labels = {
    stable: "长期稳定",
    emerging: "新出现",
    unstable: "低稳定",
    weak: "证据较弱",
  };
  return labels[level] || "待评估";
}
