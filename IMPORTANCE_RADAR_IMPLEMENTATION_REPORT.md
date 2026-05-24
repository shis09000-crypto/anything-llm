# 10 维 Importance Radar Implementation Report

## Summary

Implemented a deterministic, cached 10-dimensional Importance Radar for Knowledge Graph concepts in Graph MindMap node evidence details. The radar explains relative concept importance inside the current workspace graph; it is not an objective truth score and does not call an LLM.

## Schema

Added:

- `KnowledgeNodeMetrics`
  - Stores 10 normalized scores, `reasonsJson`, `normalizedInputsJson`, `formulaVersion`, stale state, warning, last error, and worker lock fields.
  - Unique key: `workspaceId + nodeId`.
- `KnowledgeNodeMetricsSnapshot`
  - Stores daily snapshots for important nodes so drift can be detected.
- `KnowledgeNodeMetricsRecomputeRun`
  - Logs every recompute run with processed/succeeded/failed/skipped counts, lock count, duration, trigger, and errors.

Migration:

- `server/prisma/migrations/20260524010000_add_knowledge_node_metrics/migration.sql`

`KnowledgeGraph.ensureTables()` also creates these tables for local environments that have not applied migrations yet.

## Metrics Formula

Formula version: `metrics-v1`

Dimensions:

- `evidenceStrength`: evidence count, average trust proxy, document/chunk support.
- `bridgeValue`: degree/path proxy, relation diversity, document spread, with `related_to` penalty.
- `knowledgeConnectivity`: edge count, neighbor count, edge weight, confidence, with weak relation penalty.
- `traversalImportance`: usage and recent usage with time decay.
- `crossDocumentPresence`: distinct documents and chunks.
- `freshness`: recent evidence, recent usage, and node freshness with decay.
- `relationDiversity`: distinct relation types with `related_to` penalty.
- `sourceAuthority`: pinned/watched sources, chunk completeness, document coverage.
- `stability`: evidence density, document spread, evidence time span, confidence, conflict risk.
- `conflictSafety`: `100 - conflictRisk`.

All scores are integers in `0-100`. Every dimension returns Chinese-first reasons and `formulaVersion`.

## Normalized Inputs

The API returns debuggable raw/proxy inputs, including:

- `evidenceCount`
- `edgeCount`
- `documentCount`
- `chunkCount`
- `relationTypeCount`
- `conflictCount`
- `averageConfidence`
- `averageTrustScore`
- `relatedToRatio`
- `recentEvidenceCount`
- `usageCount`
- `recentUsageCount`
- `decayedUsageScore`
- `decayedFreshnessScore`

## Decay And Penalties

Usage/traversal/freshness use exponential time decay so old nodes do not permanently dominate. High `related_to` ratio reduces bridge/connectivity/diversity contributions and is called out in reasons.

## Worker

Added Bree worker:

- `knowledge-node-metrics-recompute`
- Default interval: `1hr`
- Default batch size: `50`
- Lock TTL: `900000ms`

Environment variables:

- `KNOWLEDGE_NODE_METRICS_RECOMPUTE_ENABLED=true`
- `KNOWLEDGE_NODE_METRICS_RECOMPUTE_INTERVAL=1hr`
- `KNOWLEDGE_NODE_METRICS_RECOMPUTE_BATCH_SIZE=50`
- `KNOWLEDGE_NODE_METRICS_LOCK_TTL_MS=900000`

The worker only processes stale/missing rows for `metrics-v1`, prioritizing high usage, high workspace importance, high evidence, high degree, and recently updated nodes. DB-level best-effort locks prevent duplicate recompute by concurrent workers.

## Stale Triggers

Metrics are marked stale when:

- new edge/evidence is written;
- `ConceptChunkMap` is updated;
- evidence usage is recorded;
- graph backfill completes;
- repair completes;
- cleanup/decay completes;
- document graph data is deleted.

GET APIs do not compute synchronously. Stale metrics return existing values with `stale=true`; missing metrics return an empty state. Lazy recompute can be queued asynchronously by API.

## API

Added:

- `GET /api/workspace/:slug/knowledge/node-metrics?nodeId=<id>`
- `GET /api/workspace/:slug/knowledge/node-metrics?concept=<name>`
- `POST /api/workspace/:slug/knowledge/node-metrics/recompute`

Response includes `node`, `radar`, `normalizedInputs`, `formulaVersion`, `updatedAt`, `stale`, `warning`, and optional `emptyReason`.

## CLI

Added:

```bash
node scripts/recomputeKnowledgeNodeMetrics.js --workspace <slug>
node scripts/recomputeKnowledgeNodeMetrics.js --all
node scripts/recomputeKnowledgeNodeMetrics.js --node <nodeId>
```

CLI recompute writes the same persisted metrics and run log as the worker.

## Frontend

Graph MindMap EvidencePanel now shows an Importance Radar for graph node selections:

- compact mode shows core dimensions: evidence, bridge, traversal, source.
- full mode shows all 10 dimensions.
- lightweight SVG radar, no chart dependency.
- hover/focus displays Chinese reasons.
- stale, empty, and warning states are explicit.
- “查看计算依据” expands reasons and normalized inputs.
- stale or missing metrics trigger lazy recompute without blocking the UI.
- metrics are cached in-memory per node to avoid repeated requests.

Edge evidence views do not show node radar.

## Validation

Completed:

- `npx prisma validate --schema=prisma/schema.prisma`
- `yarn test server/__tests__/utils/knowledgeGraph/nodeMetrics.test.js --runInBand`
- Node syntax checks for metrics module, worker, and CLI.

## Known Limits

- Bridge value uses deterministic degree/two-hop path proxy, not community detection.
- Trust and source authority are explainable heuristics, not human-reviewed ratings.
- Drift detection compares against latest snapshot only in v1.
- Frontend shows cached stale values until the background worker or lazy recompute updates persistence.

## Future Work

- Add weekly trend charts using snapshots.
- Use richer conflict evidence when pair/path evidence views are implemented.
- Add workspace-level metric health summary to the Graph tab.
- Add optional admin controls for forcing recompute of selected high-value nodes.
