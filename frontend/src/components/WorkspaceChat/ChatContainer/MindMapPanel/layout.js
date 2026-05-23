import ELK from "elkjs/lib/elk.bundled.js";

const elk = new ELK();
const NODE_WIDTH = 280;
const NODE_HEIGHT = 164;
const RADIUS_STEP = 300;

export function visibleMindMap(schema = {}, collapsed = new Set()) {
  const nodes = Array.isArray(schema.nodes) ? schema.nodes : [];
  const edges = Array.isArray(schema.edges) ? schema.edges : [];
  const children = new Map();
  nodes.forEach((node) => {
    if (!node.parentId) return;
    children.set(node.parentId, [
      ...(children.get(node.parentId) || []),
      node.id,
    ]);
  });

  const hidden = new Set();
  function hideDescendants(nodeId) {
    (children.get(nodeId) || []).forEach((childId) => {
      hidden.add(childId);
      hideDescendants(childId);
    });
  }
  collapsed.forEach(hideDescendants);

  const visibleNodes = nodes.filter((node) => !hidden.has(node.id));
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  return {
    nodes: visibleNodes,
    edges: edges.filter(
      (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)
    ),
    childCounts: children,
  };
}

export async function layoutMindMap(schema = {}, collapsed = new Set()) {
  const layout = schema.layout || "tree";
  const visible = visibleMindMap(schema, collapsed);
  if (layout === "radial") return radialLayout(visible, schema);

  const direction =
    layout === "timeline" || layout === "flow" ? "RIGHT" : "DOWN";
  const spacing = layout === "comparison" ? "90" : "70";
  const graph = {
    id: "mind-map",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.spacing.nodeNode": spacing,
      "elk.layered.spacing.nodeNodeBetweenLayers": "110",
    },
    children: visible.nodes.map((node) => ({
      id: node.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    edges: visible.edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  };

  const result = await elk.layout(graph);
  const positions = new Map(
    (result.children || []).map((node) => [
      node.id,
      { x: node.x || 0, y: node.y || 0 },
    ])
  );
  return toFlowElements(visible, schema, positions);
}

function radialLayout(visible, schema) {
  const byLevel = new Map();
  visible.nodes.forEach((node) => {
    const level = Number(node.level || 0);
    byLevel.set(level, [...(byLevel.get(level) || []), node]);
  });
  const positions = new Map();
  [...byLevel.entries()].forEach(([level, nodes]) => {
    if (level === 0 || nodes.length === 1) {
      nodes.forEach((node, index) =>
        positions.set(node.id, {
          x: index * (NODE_WIDTH + 40),
          y: level * (NODE_HEIGHT + 40),
        })
      );
      return;
    }
    const radius = Math.max(level, 1) * RADIUS_STEP;
    nodes.forEach((node, index) => {
      const angle = (Math.PI * 2 * index) / nodes.length;
      positions.set(node.id, {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      });
    });
  });
  return toFlowElements(visible, schema, positions);
}

function toFlowElements(visible, schema, positions) {
  const childCounts = visible.childCounts;
  return {
    nodes: visible.nodes.map((node) => ({
      id: node.id,
      type: "mindMapNode",
      position: positions.get(node.id) || { x: 0, y: 0 },
      data: {
        ...node,
        theme: schema.theme,
        hasChildren: (childCounts.get(node.id) || []).length > 0,
      },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    edges: visible.edges.map((edge) => {
      const confidence = Number(edge.confidence ?? 0.7);
      const visualWeight = Math.max(1.2, Math.min(4.6, 1.2 + confidence * 3));
      const color = edge.color || "#94a3b8";
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label || "",
        type: "smoothstep",
        animated: schema.layout === "flow",
        data: { ...edge },
        style: {
          stroke: color,
          strokeWidth: visualWeight,
          opacity: Math.max(0.38, Math.min(0.95, 0.35 + confidence * 0.6)),
        },
        labelStyle: {
          fill: color,
          fontSize: 11,
          fontWeight: confidence >= 0.75 ? 600 : 500,
        },
        labelBgStyle: {
          fill: "#ffffff",
          fillOpacity: 0.82,
        },
      };
    }),
  };
}
