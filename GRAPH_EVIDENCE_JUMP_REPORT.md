# Graph MindMap Evidence Jump Implementation Report

## Summary

Graph MindMap now supports lazy-loaded evidence inspection for Knowledge Graph nodes and edges. Clicking a graph node or relation opens an evidence panel that shows original snippets, source documents/chunks, explainable trust scoring, stability, source authority, conflict severity, drift signals, and "Why No Evidence" guidance.

This implementation is read-only for graph semantics. It does not call an LLM, does not rewrite evidence text, does not modify traversal, does not change graph layout, and does not connect graph results into the main retrieval path.

## Backend Architecture

- Added `server/utils/knowledgeGraph/evidence.js`.
- Added APIs:
  - `GET /api/workspace/:slug/knowledge/evidence/node`
  - `GET /api/workspace/:slug/knowledge/evidence/edge`
  - `POST /api/workspace/:slug/knowledge/evidence/usage`
- Added `KnowledgeGraphEvidenceUsage` to Prisma schema and SQLite migration.

Evidence is assembled from:

- `KnowledgeNode`
- `KnowledgeEdge`
- `EdgeEvidence`
- `ConceptChunkMap`
- `workspace_documents`
- existing vector-cache or source-text readback through the current chunk helpers

## Evidence Rules

- Snippets use `EdgeEvidence.snippet` first.
- If a snippet is missing, the extractor finds nearby original sentences from the chunk text.
- Full chunk text is returned only for manual expansion.
- Evidence text is never LLM-generated, polished, summarized, or rewritten.

## Explainable Trust

The backend returns deterministic scoring metadata:

- `rankScore`
- `trustScore`
- `trustLevel`
- `trustReasons`
- `trustBreakdown`
- `relationStability`
- `sourceAuthority`
- `conflicts`
- `drift`
- `whyThisEvidence`
- `whyNoEvidence`

Trust scoring combines confidence, multi-source support, relation stability, chunk quality, source authority, and conflict penalty. Every high or low trust result includes human-readable Chinese reasons.

## Conflict, Drift, And Clustering

- Conflict detection is ontology-aware and deterministic.
- Severity levels: `mild`, `moderate`, `severe`.
- Drift levels: `none`, `watch`, `degrading`.
- Evidence clusters: definition, mechanism, structure, history, comparison, application, other.

## Frontend UX

Graph MindMap node/edge clicks now open an `EvidencePanel` without changing graph schema, nodes, edges, or layout. The panel supports:

- Chinese-first labels and explanations.
- Trust, stability, source authority, conflict, and drift badges.
- Cluster filter.
- Sorting by trust, rank, or timeline.
- Pagination.
- Full chunk expansion.
- In-panel source jump to the evidence card/chunk context.
- Markdown citation copy.
- "Continue asking" prompt insertion.
- Usage metric reporting for view, jump, copy, ask, and expand_chunk.

Existing AI MindMap generation, export, saved maps, document import, and Graph MindMap traversal behavior remain unchanged.

## Validation

Focused tests cover:

- Original-text snippet extraction.
- Trust score and breakdown.
- Stable vs emerging relation classification.
- Conflict severity.
- Evidence clustering.
- Why No Evidence.
- Source authority.
- Evidence drift.
- Usage table schema validation through Prisma.

## Known Limits

- "Jump to original" v1 scrolls to the evidence location inside the EvidencePanel and expands the raw chunk. Deeper integration with the document/source viewer can be added later.
- Conflict and drift detection are conservative deterministic signals; they flag risk but do not rewrite or delete graph semantics.
- Evidence usage metrics are observational only and do not affect traversal or ranking yet.

