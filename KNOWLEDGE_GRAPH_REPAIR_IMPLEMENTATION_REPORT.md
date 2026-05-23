# Knowledge Graph Repair Implementation Report

## Overview

This implementation adds a conservative Knowledge Graph repair layer for AnythingLLM. The repair system restores graph health by detecting missing vector-cache, missing graph jobs, stale/failed extraction jobs, sparse graph coverage, and suspicious relation density. It remains fully decoupled from the main retrieval path.

## Architecture

- `KnowledgeGraphRepairIssue` stores deduplicated repair issues per workspace/document/chunk.
- `KnowledgeGraphRepairRun` stores each repair run summary, budget usage, provider health, and graph quality metrics.
- `server/jobs/knowledge-graph-repair.js` runs as a default background job every 6 hours unless disabled by `KNOWLEDGE_GRAPH_REPAIR_ENABLED=false`.
- `server/utils/knowledgeGraph/repair/` contains scan, priority, budget, backoff, quarantine, vector-cache recovery, metrics, and repair execution modules.

## Repair Behavior

- Priority favors root concepts, high workspace importance, traversal usage, and evidence-backed chunks.
- Budgets limit tokens, provider calls, batch size, and run duration.
- Retry backoff prevents repair storms after provider/network failures.
- Successful repairs enter a 24-hour cooldown to avoid repeated deep scans.
- Quarantine pauses graph ingestion for low-quality or repeatedly failing chunks/documents without deleting documents, vectors, or existing graph data.

## Vector Cache Recovery

- The system first attempts zero-cost vector readback for LanceDB and rebuilds standard vector-cache with existing vector values.
- If vector readback is unsupported but source `pageContent` exists, KG extraction can still proceed through the graph-only text fallback.
- Automatic repair never re-embeds.
- Manual `allowReembed=true` requires the configured embedding engine to be DashScope-compatible `generic-openai` with `text-embedding-v4`.

## API/UI

- `GET /api/workspace/:slug/knowledge/repair-status`
- `POST /api/workspace/:slug/knowledge/repair`
- `POST /api/workspace/:slug/knowledge/repair/quarantine/:issueId/release`

The Graph MindMap tab now displays repair health, recent repair reasons, quarantine explanations, needs-reembed counts, and recent method/error information.

## Guardrails

- Repair restores graph health; it does not reinterpret graph semantics.
- Repair does not automatically modify existing relation meanings.
- Repair does not alter the main vector retrieval path.
- Automatic repair does not re-embed or rebuild vector rows.

## Validation

Recommended commands:

```bash
cd /Users/shijie/Desktop/anything-llm/server && npx prisma validate --schema=prisma/schema.prisma
cd /Users/shijie/Desktop/anything-llm/server && yarn lint:check
cd /Users/shijie/Desktop/anything-llm && yarn test server/__tests__/utils/knowledgeGraph/repair.test.js --runInBand
cd /Users/shijie/Desktop/anything-llm/frontend && yarn lint:check
cd /Users/shijie/Desktop/anything-llm/frontend && NODE_OPTIONS=--max-old-space-size=4096 yarn build
cd /Users/shijie/Desktop/anything-llm && git diff --check
```
