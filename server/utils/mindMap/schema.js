const { safeJsonParse } = require("../http");

const MIND_MAP_SCHEMA_VERSION = "1.0.0";
const MIND_MAP_PROMPT_VERSION = "mind-map-v1";
const MAX_MIND_MAP_NODES = 500;
const VALID_LAYOUTS = ["radial", "tree", "timeline", "flow", "comparison"];
const VALID_THEMES = ["napkin", "ocean", "forest", "sunset", "mono"];
const DEFAULT_THEME = "napkin";
const DEFAULT_LAYOUT = "tree";
const PALETTE = [
  "#F3E8FF",
  "#DBEAFE",
  "#DCFCE7",
  "#FEF3C7",
  "#FFE4E6",
  "#E0F2FE",
  "#F5F5F4",
];
const NODE_META_FIELDS = [
  "importanceScore",
  "workspaceImportanceScore",
  "recentImportanceScore",
  "sourceNodeId",
  "canonicalName",
  "displayNameZh",
  "displayNameEn",
  "aliases",
  "evidenceCount",
  "topChunks",
  "collapsedByDefault",
  "size",
  "sourceType",
  "clusterKey",
  "clusterLabel",
];
const EDGE_META_FIELDS = [
  "relationType",
  "relationLabelZh",
  "relationLabelEn",
  "displayLabel",
  "displayLabelZh",
  "displayLabelEn",
  "shouldShowLabel",
  "labelModeDefault",
  "edgeRole",
  "isMainEdge",
  "isBranchEdge",
  "isSupportEdge",
  "isWeakRelation",
  "isConflictEdge",
  "isLayoutEdge",
  "isCycleEdge",
  "isPrimaryEdge",
  "clickable",
  "confidence",
  "weight",
  "visualWeight",
  "visualOpacity",
  "visualStyle",
  "trustScore",
  "trustLevel",
  "trustReasons",
  "evidenceSupportLevel",
  "evidenceCount",
  "firstSeenAt",
  "latestSeenAt",
  "evidenceTimeRange",
  "documentIds",
  "chunkIds",
  "evidence",
  "color",
];

function slugId(value = "", fallback = "node") {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

function uniqueId(base, seen) {
  let candidate = base;
  let idx = 2;
  while (seen.has(candidate)) {
    candidate = `${base}-${idx}`;
    idx += 1;
  }
  seen.add(candidate);
  return candidate;
}

function parseMindMapJson(raw = "") {
  if (typeof raw === "object" && raw !== null) return raw;
  const text = String(raw || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  const sliced =
    firstBrace >= 0 && lastBrace > firstBrace
      ? candidate.slice(firstBrace, lastBrace + 1)
      : candidate;

  try {
    return JSON.parse(sliced);
  } catch {
    try {
      const { jsonrepair } = require("jsonrepair");
      return JSON.parse(jsonrepair(sliced));
    } catch {
      return safeJsonParse(sliced, null);
    }
  }
}

function normalizeMindMapSchema(input, options = {}) {
  const source = typeof input === "string" ? parseMindMapJson(input) : input;
  if (!source || typeof source !== "object")
    throw new Error("mind_map_invalid_json");

  const layout = VALID_LAYOUTS.includes(source.layout)
    ? source.layout
    : VALID_LAYOUTS.includes(options.layout)
      ? options.layout
      : DEFAULT_LAYOUT;
  const theme = VALID_THEMES.includes(source.theme)
    ? source.theme
    : VALID_THEMES.includes(options.theme)
      ? options.theme
      : DEFAULT_THEME;
  const recommendedLayout = VALID_LAYOUTS.includes(source.recommendedLayout)
    ? source.recommendedLayout
    : layout;

  const rawNodes = Array.isArray(source.nodes) ? source.nodes : [];
  if (rawNodes.length === 0) throw new Error("mind_map_missing_nodes");

  const seenIds = new Set();
  const idMap = new Map();
  const nodes = rawNodes.slice(0, MAX_MIND_MAP_NODES).map((node, index) => {
    const base = slugId(node?.id || node?.label || `node-${index + 1}`);
    const id = uniqueId(base, seenIds);
    idMap.set(String(node?.id || base), id);
    return {
      id,
      label: String(node?.label || `Node ${index + 1}`).slice(0, 120),
      description: String(node?.description || "").slice(0, 700),
      icon: String(node?.icon || defaultIcon(node?.level ?? index)).slice(0, 4),
      level: Number.isFinite(Number(node?.level)) ? Number(node.level) : 1,
      color: isHexColor(node?.color)
        ? node.color
        : PALETTE[index % PALETTE.length],
      parentId: node?.parentId ? String(node.parentId) : null,
      ...pickNodeMetadata(node),
    };
  });

  const nodeIds = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    if (!node.parentId) continue;
    node.parentId = idMap.get(node.parentId) || slugId(node.parentId);
    if (!nodeIds.has(node.parentId)) node.parentId = null;
  }

  const normalizedEdges = [];
  const edgeSeen = new Set();
  const rawEdges = Array.isArray(source.edges) ? source.edges : [];
  for (const edge of rawEdges) {
    const sourceId = idMap.get(String(edge?.source)) || slugId(edge?.source);
    const targetId = idMap.get(String(edge?.target)) || slugId(edge?.target);
    if (
      !nodeIds.has(sourceId) ||
      !nodeIds.has(targetId) ||
      sourceId === targetId
    )
      continue;
    const id = uniqueId(
      slugId(edge?.id || `${sourceId}-${targetId}`, "edge"),
      edgeSeen
    );
    normalizedEdges.push({
      id,
      source: sourceId,
      target: targetId,
      label: edge?.label ? String(edge.label).slice(0, 80) : "",
      type: edge?.type ? String(edge.type).slice(0, 40) : "related",
      ...pickEdgeMetadata(edge),
    });
  }

  for (const node of nodes) {
    if (!node.parentId) continue;
    const id = uniqueId(`${node.parentId}-${node.id}`, edgeSeen);
    if (
      normalizedEdges.some(
        (edge) =>
          (edge.source === node.parentId && edge.target === node.id) ||
          (edge.source === node.id && edge.target === node.parentId)
      )
    )
      continue;
    normalizedEdges.push({
      id,
      source: node.parentId,
      target: node.id,
      label: "",
      type: "layout",
      edgeRole: "layout",
      isLayoutEdge: true,
      clickable: false,
      shouldShowLabel: false,
      labelModeDefault: "hidden",
      visualWeight: 1,
      visualOpacity: 0.18,
      visualStyle: "layout",
    });
  }

  if (normalizedEdges.length === 0 && nodes.length > 1) {
    const root = nodes.find((node) => !node.parentId) || nodes[0];
    nodes
      .filter((node) => node.id !== root.id)
      .forEach((node) =>
        normalizedEdges.push({
          id: `${root.id}-${node.id}`,
          source: root.id,
          target: node.id,
          label: "",
          type: "related",
        })
      );
  }

  return {
    title: String(source.title || options.title || "Mind Map").slice(0, 140),
    layout,
    theme,
    recommendedLayout,
    summary: source.summary ? String(source.summary).slice(0, 1_200) : "",
    nodes,
    edges: normalizedEdges,
  };
}

function pickNodeMetadata(node = {}) {
  const metadata = {};
  for (const field of NODE_META_FIELDS) {
    if (node[field] === undefined) continue;
    metadata[field] = node[field];
  }
  if (Array.isArray(metadata.aliases))
    metadata.aliases = metadata.aliases.map(String).slice(0, 20);
  if (Array.isArray(metadata.topChunks))
    metadata.topChunks = metadata.topChunks.slice(0, 5);
  [
    "importanceScore",
    "workspaceImportanceScore",
    "recentImportanceScore",
  ].forEach((field) => {
    if (metadata[field] === undefined) return;
    metadata[field] = Number(metadata[field] || 0);
  });
  if (metadata.evidenceCount !== undefined)
    metadata.evidenceCount = Number(metadata.evidenceCount || 0);
  return metadata;
}

function pickEdgeMetadata(edge = {}) {
  const metadata = {};
  for (const field of EDGE_META_FIELDS) {
    if (edge[field] === undefined) continue;
    metadata[field] = edge[field];
  }
  if (metadata.confidence !== undefined)
    metadata.confidence = Math.max(
      0,
      Math.min(1, Number(metadata.confidence || 0))
    );
  if (metadata.weight !== undefined)
    metadata.weight = Number(metadata.weight || 0);
  if (metadata.evidenceCount !== undefined)
    metadata.evidenceCount = Number(metadata.evidenceCount || 0);
  if (metadata.visualWeight !== undefined)
    metadata.visualWeight = Number(metadata.visualWeight || 0);
  if (metadata.visualOpacity !== undefined)
    metadata.visualOpacity = Math.max(
      0,
      Math.min(1, Number(metadata.visualOpacity || 0))
    );
  if (metadata.trustScore !== undefined)
    metadata.trustScore = Math.max(
      0,
      Math.min(1, Number(metadata.trustScore || 0))
    );
  [
    "shouldShowLabel",
    "isMainEdge",
    "isBranchEdge",
    "isSupportEdge",
    "isWeakRelation",
    "isConflictEdge",
    "isLayoutEdge",
    "isCycleEdge",
    "isPrimaryEdge",
    "clickable",
  ].forEach((field) => {
    if (metadata[field] !== undefined)
      metadata[field] = Boolean(metadata[field]);
  });
  if (Array.isArray(metadata.trustReasons))
    metadata.trustReasons = metadata.trustReasons.map(String).slice(0, 5);
  if (Array.isArray(metadata.documentIds))
    metadata.documentIds = metadata.documentIds.map(String).slice(0, 20);
  if (Array.isArray(metadata.chunkIds))
    metadata.chunkIds = metadata.chunkIds.map(String).slice(0, 20);
  if (Array.isArray(metadata.evidence))
    metadata.evidence = metadata.evidence.slice(0, 5);
  return metadata;
}

function defaultIcon(level) {
  if (Number(level) <= 0) return "*";
  if (Number(level) === 1) return "o";
  return "-";
}

function isHexColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || ""));
}

function mindMapToMarkdown(schema = {}) {
  const nodes = Array.isArray(schema.nodes) ? schema.nodes : [];
  const edges = Array.isArray(schema.edges) ? schema.edges : [];
  const byParent = new Map();
  nodes.forEach((node) => {
    const key = node.parentId || "__root__";
    byParent.set(key, [...(byParent.get(key) || []), node]);
  });

  const lines = [`# ${schema.title || "Mind Map"}`, ""];
  if (schema.summary) lines.push(schema.summary, "");

  function walk(parentId = "__root__", depth = 0) {
    const children = byParent.get(parentId) || [];
    children.forEach((node) => {
      lines.push(`${"  ".repeat(depth)}- ${node.label}`);
      if (node.description)
        lines.push(`${"  ".repeat(depth + 1)}- ${node.description}`);
      walk(node.id, depth + 1);
    });
  }

  walk();
  if (edges.length) {
    lines.push("", "## Relationships");
    edges.forEach((edge) => {
      const source = nodes.find((node) => node.id === edge.source)?.label;
      const target = nodes.find((node) => node.id === edge.target)?.label;
      if (!source || !target) return;
      lines.push(
        `- ${source} -> ${target}${edge.label ? `: ${edge.label}` : ""}`
      );
    });
  }
  return lines.join("\n");
}

module.exports = {
  MIND_MAP_SCHEMA_VERSION,
  MIND_MAP_PROMPT_VERSION,
  MAX_MIND_MAP_NODES,
  VALID_LAYOUTS,
  VALID_THEMES,
  DEFAULT_THEME,
  DEFAULT_LAYOUT,
  normalizeMindMapSchema,
  parseMindMapJson,
  mindMapToMarkdown,
};
