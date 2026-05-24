# Graph MindMap Edge Readability Refactor Report

## Summary

This refactor makes Graph MindMap edges readable by adding Chinese-first relation labels, edge role layering, custom React Flow edge rendering, relation filters, label modes, and layout anti-spiderweb behavior. The change is limited to graph visualization and exploration. It does not modify graph extraction, vector retrieval, embedding, or the main chat retrieval path.

## Modified Areas

- `server/utils/mindMap/graph.js`
  - Adds Chinese-first relation display labels.
  - Adds `edgeRole` classification: `main`, `branch`, `support`, `weak`, `conflict`, `layout`.
  - Adds visual metadata, trust hints, evidence support level, temporal evidence range, and deterministic cluster labels.
- `server/utils/mindMap/schema.js`
  - Preserves new graph edge/node metadata through normalization.
  - Converts synthetic parent fallback edges into non-clickable `layout` edges.
  - Avoids adding fake parent edges when a real KG edge already connects the parent/child pair in either direction.
- `frontend/src/components/WorkspaceChat/ChatContainer/MindMapPanel/GraphMindMapEdge.jsx`
  - Adds a custom graph edge with Chinese labels, arrows, hover tooltip, selected/path highlighting, and weak/conflict styling.
- `frontend/src/components/WorkspaceChat/ChatContainer/MindMapPanel/layout.js`
  - Uses only `main`, `branch`, and `layout` edges for ELK layout.
  - Renders support/weak/cycle edges as overlays after node positions are computed.
- `frontend/src/components/WorkspaceChat/ChatContainer/MindMapPanel/index.jsx`
  - Adds edge filters, label modes, large-graph simplification, stable position cache, and a lightweight Path View control.
- `server/utils/knowledgeGraph/path.js`
  - Adds bounded read-only multi-hop path search for reasoning chain exploration.
- `server/endpoints/knowledgeGraph.js`
  - Adds `GET /workspace/:slug/knowledge/path`.

## Edge Role Rules

- `main`: selected parent/backbone KG edge, high priority for layout and default label display.
- `branch`: high-confidence, evidence-backed, specific relation that is not `related_to`.
- `support`: evidence-backed auxiliary relation.
- `weak`: low confidence, no evidence, or `related_to`.
- `conflict`: relation with conflict metadata.
- `layout`: synthetic layout helper only; hidden label, not clickable, not evidence-backed.

## Chinese Relation Mapping

- `causes` -> `导致`
- `part_of` -> `属于/组成`
- `depends_on` -> `依赖`
- `regulates` -> `调控`
- `related_to` -> `相关`
- `contrasts_with` -> `对比/相反`
- `precedes` -> `先于`
- `used_in` -> `用于`
- `acts_at` -> `作用于`
- `implements` -> `实现/体现`
- `references` -> `引用`

Display priority is: `relationLabelZh`, ontology Chinese label, `relationLabelEn`, original `relationLabel`, then `relationType`.

## Visual Rules

- Main edges use thick solid lines, high opacity, arrowheads, and visible Chinese labels.
- Branch edges use medium solid lines and visible or automatic labels.
- Support edges are thinner and mostly hover-labeled.
- Weak edges use thin dashed low-opacity lines and are hidden by default filters.
- Conflict edges use orange warning styling and hover warning text.
- Layout edges are pale, non-clickable, and do not pretend to be evidence-backed relations.

## Filters And Label Modes

The Graph tab now includes:

- `只看主线`
- `隐藏弱关系`
- `隐藏“相关”`
- relation type filter in Chinese categories
- label modes: automatic, main only, hover, all, hidden

Large graphs automatically simplify when `nodes > 40` or `edges > 80`, hiding weak/related edges and reducing labels to the backbone.

## Layout Anti-Spiderweb Strategy

ELK receives only backbone edges (`main`, `branch`, `layout`). Dense support, weak, cycle, and secondary relations render as overlays after node placement. This prevents low-value graph edges from pulling the layout into a noisy mesh.

## Evidence Jump Linkage

Real KG edges keep stable IDs in the `kg-edge-<id>` format, so clicking an edge continues to open the EvidencePanel. Synthetic layout edges are explicitly marked `clickable=false` and do not open evidence.

## Stable Layout And Path View Foundations

- A frontend position cache keeps node placement stable across filtering and label-mode changes.
- The new read-only path API supports bounded `A -> B -> C -> D` reasoning chains without touching retrieval.
- Path View can highlight selected path nodes/edges in the current graph.

## Tests

Focused coverage was added for:

- graph metadata preservation
- Chinese relation label priority
- edge role classification
- stable relation color mapping

Manual QA targets:

- `Chromatin`
- `HP1`
- `Gene duplication`

Expected behavior:

- default view is cleaner than before
- main/branch/support/weak relations are visually distinct
- weak/related relations are hidden by default
- hover edge shows relation explanation
- clicking KG edge opens evidence
- layout edge is not clickable
- AI MindMap mode remains unchanged

## Known Limits

- Conflict detection depends on available conflict metadata from the evidence layer; it is not inferred by LLM.
- Semantic clustering is deterministic v1 metadata, not full community detection.
- Path View is read-only exploration and is not yet connected into the main retrieval/chat pipeline.
- Narrative, temporal filters, personalized graph ranking, and graph-driven chat highlighting remain future staged work.
