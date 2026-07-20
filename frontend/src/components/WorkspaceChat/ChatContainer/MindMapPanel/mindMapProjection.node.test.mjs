import assert from "node:assert/strict";
import test from "node:test";

import {
  conceptName,
  defaultCollapsed,
  documentSubtitle,
  documentTitle,
  filterGraphSchema,
  formatAliases,
  parseGraphEdgeId,
  safeFilename,
} from "./mindMapProjection.js";

test("graph projection preserves main edges and enforces the weak-edge budget", () => {
  const schema = {
    nodes: [
      { id: "kg-1", collapsedByDefault: true },
      { id: "kg-2" },
      { id: "kg-3" },
    ],
    edges: [
      { id: "main", source: "kg-1", target: "kg-2", isMainEdge: true },
      {
        id: "weak",
        source: "kg-1",
        target: "kg-3",
        edgeRole: "weak",
        isWeakRelation: true,
        relationType: "related_to",
      },
    ],
  };

  const projected = filterGraphSchema(schema, {
    autoSimplified: true,
    hideWeakRelations: true,
    labelMode: "auto",
    selectedPath: { nodeIds: [2], edgeIds: [] },
  });

  assert.deepEqual(
    projected.edges.map((edge) => edge.id),
    ["main"]
  );
  assert.equal(projected.edgeLabelMode, "main");
  assert.equal(projected.nodes[1].isPathNode, true);
  assert.deepEqual([...defaultCollapsed(schema)], ["kg-1"]);
});

test("projection helpers normalize identifiers and display metadata", () => {
  assert.equal(safeFilename("  Athena 图谱 / V2.3  "), "athena-v2-3");
  assert.equal(parseGraphEdgeId("kg-edge-42"), 42);
  assert.equal(parseGraphEdgeId("edge-42"), null);
  assert.deepEqual(formatAliases([{ zh: "雅典娜", en: "Athena" }, "AI"]), [
    "雅典娜",
    "Athena",
    "AI",
  ]);
  assert.equal(conceptName({ displayNameZh: "状态树" }), "状态树");
  assert.equal(documentTitle({ filename: "design.pdf" }), "design.pdf");
  assert.equal(
    documentSubtitle(
      { filename: "design.pdf", docpath: "kb/design.pdf" },
      "design.pdf"
    ),
    "kb/design.pdf"
  );
});
