# Graph MindMap Integration Report

## Summary

This implementation adds a graph-backed MindMap mode alongside the existing AI-generated MindMap flow. The new mode renders transient MindMap schemas from the local Knowledge Graph (`KnowledgeNode`, `KnowledgeEdge`, `EdgeEvidence`, and `ConceptChunkMap`) without writing graph views to `workspace_mind_maps` and without changing vector retrieval or the main chat retrieval path.

## Architecture

- Existing AI MindMap mode remains the default for assistant actions and `/mindmap`.
- New Graph MindMap mode is exposed from `MindMapPanel` as the `知识图谱` tab.
- Backend route `GET /api/workspace/:slug/mind-maps/graph` resolves a concept through the existing graph traversal system and returns a transient MindMap object.
- Concept search uses `GET /api/workspace/:slug/knowledge/concepts?q=...`.
- Graph health uses `GET /api/workspace/:slug/knowledge/stats`.

## Graph To Schema Conversion

`server/utils/mindMap/graph.js` converts traversal output into `MindMapSchema`:

- Root node is the matched queried concept.
- First-hop nodes use level `1`; deeper nodes use higher levels.
- Cycles are handled by selecting one strongest parent edge per node for hierarchy while keeping relationship edges in the schema.
- Weak branches are marked with `collapsedByDefault` when confidence or importance is low.
- Graph node metadata is preserved for UI preview and evidence display:
  - `sourceNodeId`
  - `aliases`
  - `evidenceCount`
  - `topChunks`
  - `importanceScore`
  - `workspaceImportanceScore`
  - `recentImportanceScore`

## Ontology Styling

Relation types map to stable visual colors:

- `causes`: orange
- `part_of`: blue
- `depends_on`: purple
- `regulates`: green
- `related_to`: gray
- other ontology relations: neutral/slate

## Edge Visual Weight

Frontend layout maps edge `confidence` to line thickness and opacity:

- Higher confidence edges are thicker and more opaque.
- Lower confidence edges remain visible but visually lighter.
- Edge metadata is passed through React Flow `edge.data`, so selecting an edge can show evidence and relation details.

## Hover Preview

Graph nodes show a lightweight hover preview with:

- aliases
- evidence count
- overall/workspace/recent importance
- top related chunks

The preview is overlay-only and does not trigger layout changes.

## Evidence Jump Behavior

Node and edge selection opens a bottom evidence surface:

- Node selection shows top related chunks from `ConceptChunkMap`.
- Edge selection shows evidence snippets from `EdgeEvidence`.
- v1 exposes source title/path, document id, and chunk id. It avoids fake navigation when a precise source-view route is not available.

## Concept Autocomplete

The Graph tab concept input queries `KnowledgeNode.canonicalName`, `canonicalKey`, and aliases. Results are ordered by workspace/recent importance and capped server-side.

## Graph Health Summary

The Graph tab displays:

- node count
- edge count
- evidence count
- derived backfill status

If the workspace graph is sparse, the UI shows a gentle warning that results may be incomplete and recommends running Knowledge Graph backfill.

## Empty State

When a concept is not found, the Graph tab displays:

- `没有找到该概念。`
- suggestions to try another keyword, run backfill, or search generated nodes
- graph health summary for context

## Traversal And Cache Strategy

Graph MindMap uses the existing traversal and `GraphRetrievalCache` path:

- default `maxDepth=2`
- default `maxExpandedNodes=60`
- default `confidenceCutoff=0.45`
- server-side hard caps remain enforced by traversal helpers

Graph layout/theme/filter changes are local UI transformations and do not trigger LLM calls.

## UI Changes

- Added `AI 思维导图` and `知识图谱` tabs to `MindMapPanel`.
- Added concept autocomplete, Graph health summary, sparse warning, and graph empty state.
- Added `Expand Related Concepts`, `Focus Node`, `Hide Weak Relations`, and re-center controls.
- Reused the existing React Flow renderer and export actions for PNG, Markdown, and JSON.
- Graph transient maps skip viewport persistence because they have no persisted id.

## Manual Examples

The intended manual validation concepts are:

- `Gene duplication`
- `HP1`
- `Chromatin`

Each should return a stable graph-backed MindMap when the workspace contains matching Knowledge Graph nodes.

## Known Limits

- Graph MindMap v1 is visualization/exploration only.
- It does not connect the graph into the main retrieval/chat pipeline.
- It does not persist graph snapshots.
- Evidence selection currently exposes source metadata rather than deep-linking into every possible document viewer.
- Large dense clusters may still need future community collapse.

## Future Work

- Community/cluster collapse for dense topic clusters.
- Incremental node expansion to avoid full relayout on every expansion.
- Dedicated “Why Connected?” panel with evidence and confidence explanation.
- Temporal filters for recent versus historical relations.
- Optional persisted graph snapshots for saved graph views.
