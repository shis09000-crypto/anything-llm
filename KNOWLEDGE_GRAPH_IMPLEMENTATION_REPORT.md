# Knowledge Graph Implementation Report

## Summary

This implementation adds a lightweight incremental Knowledge Graph pipeline to AnythingLLM as a retrieval augmentation foundation. It preserves the existing document, chunk, vector, and embedding flow. Graph extraction is scheduled only after vectors are successfully written, and failures are isolated to graph job status.

The current codebase does not have a first-class chunk table, so graph `chunkId` is intentionally mapped to `document_vectors.vectorId`; `documentId` maps to `workspace_documents.docId`.

## Schema

New Prisma models and SQLite tables:

- `KnowledgeNode`
  - Canonical concept/entity node with workspace scoped `canonicalKey`.
  - Tracks `globalImportanceScore`, `workspaceImportanceScore`, and `recentImportanceScore`.
  - Keeps `embedding`, `embeddingModel`, and `embeddingVersion` fields for future semantic merge.
- `KnowledgeEdge`
  - Canonical relation between two nodes.
  - Stores normalized `relationType`, original `relationLabel`, confidence, weight, usage, and graph version fields.
- `EdgeEvidence`
  - Stores multiple source chunks/documents for a single edge.
  - Explains why two concepts are related.
- `ConceptChunkMap`
  - Bidirectional Concept to Chunk index for future graph expansion retrieval.
- `GraphExtractionJob`
  - Per-vector-chunk extraction state and retry/error tracking.
- `GraphRetrievalCache`
  - Caches neighbor expansion for hot concepts.

Migration:

- `server/prisma/migrations/20260523000000_add_knowledge_graph/migration.sql`

Runtime table safety is implemented in:

- `server/models/knowledgeGraph.js`

## Modified Files

Primary Knowledge Graph files:

- `server/prisma/schema.prisma`
- `server/prisma/migrations/20260523000000_add_knowledge_graph/migration.sql`
- `server/models/knowledgeGraph.js`
- `server/endpoints/knowledgeGraph.js`
- `server/scripts/backfillKnowledgeGraph.js`
- `server/utils/knowledgeGraph/*.js`
- `server/__tests__/utils/knowledgeGraph/schema.test.js`

Integration points:

- `server/index.js`
- `server/models/documents.js`
- `server/jobs/embedding-worker.js`
- `server/utils/DocumentEmbeddingBatch/index.js`
- `server/utils/EmbeddingWorkerManager.js`

## Extraction Pipeline

Core modules live in `server/utils/knowledgeGraph/`:

- `promptRegistry.js`
  - Deterministic domain detection.
  - v1 domains: `default`, `code`, `finance`, `biology`, `ai`.
- `extractGraph.js`
  - Uses the existing DeepSeek provider class.
  - Model is configured by `KNOWLEDGE_GRAPH_DEEPSEEK_MODEL`.
  - Defaults to `deepseek-chat` when the env var is absent.
  - This is the DeepSeek Flash integration point; set `KNOWLEDGE_GRAPH_DEEPSEEK_MODEL` to the deployed Flash model id.
- `schema.js`
  - Strict JSON normalization.
  - Uses `jsonrepair` for malformed JSON.
  - Caps to 20 entities and 30 relations per chunk.
  - Clips chunk input to 8,000 chars.
- `mergeKnowledgeNode.js`
  - Workspace scoped canonical merge.
  - Case-insensitive and whitespace-normalized matching.
  - Alias matching.
  - Node embedding hook is present but disabled by default.
- `createKnowledgeEdge.js`
  - Normalizes relation types.
  - Upserts edges.
  - Adds `EdgeEvidence`.
- `conceptChunkMap.js`
  - Maintains concept-to-chunk map rows.
- `importance.js`
  - Updates global/workspace/recent node importance.
- `traversal.js`
  - Bounded graph expansion for related concepts.
- `cleanup.js`
  - Confidence decay and conservative cleanup.
- `graphAwareRerank.js`
  - Server-side helper for future vector + graph reranking.

## Relation Ontology

Relation ontology v1:

- `related_to`
- `part_of`
- `causes`
- `depends_on`
- `used_in`
- `acts_at`
- `regulates`
- `contrasts_with`
- `precedes`
- `implements`
- `references`

Unknown relation labels downgrade to `related_to`; the raw label is retained in `relationLabel`.

Version field:

- `relationOntologyVersion = "relation-ontology-v1"`

## Incremental Processing

Graph jobs are scheduled after vector success in:

- `server/models/documents.js`
- `server/jobs/embedding-worker.js`
- `server/utils/DocumentEmbeddingBatch/index.js`

The native embedding worker creates graph jobs but does not run extraction inside the child process. The parent process starts pending graph work after the worker emits `all_complete`.

Graph extraction is best-effort:

- Does not block ingestion.
- Does not modify vector DB.
- Does not rebuild embeddings.
- Does not change existing retrieval behavior.

## Backfill

CLI:

```bash
cd /Users/shijie/Desktop/anything-llm/server
node scripts/backfillKnowledgeGraph.js --workspace demo
node scripts/backfillKnowledgeGraph.js --all
node scripts/backfillKnowledgeGraph.js --limit 100
node scripts/backfillKnowledgeGraph.js --workspace demo --batch-size 25 --retry --cleanup
```

Backfill reads existing:

- `workspace_documents`
- `document_vectors`
- vector-cache JSON

It does not call the embedder and does not mutate vector DB data.

## Related Concepts API

Endpoint:

```text
GET /api/workspace/:slug/knowledge/related?concept=helicase
```

Query params:

- `maxDepth`
- `maxExpandedNodes`
- `confidenceCutoff`
- `includeEvidence`

Hard caps:

- `maxDepth <= 3`
- `maxExpandedNodes <= 100`
- `perNodeFanout <= 20`

Stats endpoint:

```text
GET /api/workspace/:slug/knowledge/stats
```

## Future Retrieval Contract

Graph does not replace vector retrieval. Future GraphRAG integration should use:

```text
vector retrieval -> graph expansion -> graph-aware rerank -> context assembly
```

The v1 implementation provides:

- Concept to chunk lookup.
- Chunk to concept lookup.
- Bounded traversal.
- Graph retrieval cache.
- Graph-aware rerank helper.

It does not yet rewrite the active chat retrieval path.

## Configuration

```bash
KNOWLEDGE_GRAPH_DEEPSEEK_MODEL=deepseek-chat
KNOWLEDGE_GRAPH_WORKER_CONCURRENCY=1
KNOWLEDGE_GRAPH_ENABLE_NODE_EMBEDDINGS=false
```

`KNOWLEDGE_GRAPH_DEEPSEEK_MODEL` should be set to the deployed DeepSeek Flash model id when available.

## Testing

Focused tests:

```bash
cd /Users/shijie/Desktop/anything-llm
yarn test server/__tests__/utils/knowledgeGraph/schema.test.js
```

Current local note: the root `package.json` has a Jest script, but this checkout does not currently have root `node_modules/.bin/jest` installed, so the focused Jest command exits with `jest: command not found` until root dependencies are installed. A Node smoke check was run against the deterministic graph utilities instead.

Validation commands:

```bash
cd /Users/shijie/Desktop/anything-llm/server && yarn lint:check
cd /Users/shijie/Desktop/anything-llm/frontend && yarn lint:check
cd /Users/shijie/Desktop/anything-llm/frontend && NODE_OPTIONS=--max-old-space-size=4096 yarn build
cd /Users/shijie/Desktop/anything-llm && git diff --check
```

Validation results from this implementation pass:

- `cd /Users/shijie/Desktop/anything-llm/server && yarn lint:check` passed.
- `cd /Users/shijie/Desktop/anything-llm/server && npx prisma validate --schema=prisma/schema.prisma` passed.
- `cd /Users/shijie/Desktop/anything-llm/frontend && yarn lint:check` passed.
- `cd /Users/shijie/Desktop/anything-llm/frontend && NODE_OPTIONS=--max-old-space-size=4096 yarn build` passed with existing Vite/browserlist/chunk-size warnings.
- `cd /Users/shijie/Desktop/anything-llm && git diff --check` passed.
- `cd /Users/shijie/Desktop/anything-llm/server && npx prisma migrate status --schema=prisma/schema.prisma` reported pending local migrations: `20260520000000_add_workspace_mind_maps` and `20260523000000_add_knowledge_graph`. They were not applied automatically to avoid silently mutating the local development database.

Manual validation:

1. Ingest a new document and confirm vectors are written as before.
2. Confirm `GraphExtractionJob` rows are created after vector success.
3. Run backfill on an existing workspace.
4. Query `/api/workspace/:slug/knowledge/related?concept=<name>&includeEvidence=true`.
5. Confirm evidence includes multiple chunks/documents when the same relation appears repeatedly.
6. Confirm vector retrieval still works unchanged.

## Roadmap

- Enable node embeddings selectively for semantic merge and semantic traversal.
- Add graph-aware rerank to the active retrieval path after measuring quality.
- Add graph-powered MindMap conversion using `KnowledgeNode` and `KnowledgeEdge`.
- Add Learning Path generation from high-importance concept chains.
- Add richer cleanup metrics and admin UI visibility.
