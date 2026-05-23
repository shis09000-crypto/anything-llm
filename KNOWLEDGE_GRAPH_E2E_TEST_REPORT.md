# Knowledge Graph E2E Test Report

## Summary

Date: 2026-05-23

Validated the incremental Knowledge Graph pipeline in the local AnythingLLM environment with real DeepSeek API calls. Extraction was not mocked. The validation used the existing DeepSeek provider with `KNOWLEDGE_GRAPH_DEEPSEEK_MODEL` temporarily set from `DEEPSEEK_MODEL_PREF`.

Flash retry update:

- The 3 previously failed extraction jobs were retried without touching successful jobs.
- Requested model alias `deepseek-flash` was tested first but rejected by the DeepSeek API: the accepted Flash model id is `deepseek-v4-flash`.
- The failed jobs were then rerun with the existing DeepSeek provider and `KNOWLEDGE_GRAPH_DEEPSEEK_MODEL=deepseek-v4-flash`.
- All retried jobs completed successfully.

Tested workspace:

- Slug: `1cd3992d-e83f-44dd-a760-28e267b224ba`
- Name: `细胞分子学`
- Workspace id: `1`
- Existing workspace documents: `17`
- Existing `document_vectors`: `41`

Pre-run safety:

- Database backup: `/tmp/anythingllm-kg-e2e-20260523_014858/anythingllm.before.db`
- Vector baseline exported before the run.
- `document_vectors` row count stayed `41 -> 41`.
- `document_vectors` CSV content hash stayed unchanged: `d2cc6ce3ab73f96e2ccf09b9d699ff06d51d12b8752f0a0c525fe0da445442dd`.
- Vector-cache checksum/stat snapshots stayed unchanged.

## Backfill Results

Command:

```bash
cd /Users/shijie/Desktop/anything-llm/server
KNOWLEDGE_GRAPH_DEEPSEEK_MODEL="$DEEPSEEK_MODEL_PREF" \
  node scripts/backfillKnowledgeGraph.js \
  --workspace 1cd3992d-e83f-44dd-a760-28e267b224ba \
  --limit 12 \
  --batch-size 50
```

Results:

- Scheduled jobs: `9`
- Processed jobs: `9`
- Initial completed jobs: `6`
- Initial failed jobs: `3`
- After Flash retry: `9 completed`, `0 failed`
- Generated `KnowledgeNode` after initial run: `94`
- Generated `KnowledgeEdge` after initial run: `96`
- Generated `EdgeEvidence` after initial run: `98`
- Generated `ConceptChunkMap` after initial run: `118`
- Generated `KnowledgeNode` after Flash retry: `112`
- Generated `KnowledgeEdge` after Flash retry: `129`
- Generated `EdgeEvidence` after Flash retry: `132`
- Generated `ConceptChunkMap` after Flash retry: `169`

DeepSeek failures observed:

- Job `2`: socket timeout
- Job `4`: socket timeout
- Job `6`: premature close

Failure isolation worked: failed graph extraction jobs did not affect vector rows, vector-cache files, or completed graph rows.

Flash retry details:

| Job | Final status | Model | Prompt tokens | Completion tokens | Total tokens | Elapsed | Raw entities | Raw relations | Node delta | Edge delta | Evidence delta | Map delta |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | completed | `deepseek-v4-flash` | 3,303 | 11,947 | 15,250 | 90.397s | 20 | 19 | +6 | +18 | +19 | +20 |
| 4 | completed | `deepseek-v4-flash` | 2,676 | 3,587 | 6,263 | 26.972s | 14 | 11 | +8 | +11 | +11 | +14 |
| 6 | completed | `deepseek-v4-flash` | 2,140 | 2,118 | 4,258 | 14.372s | 17 | 5 | +4 | +4 | +4 | +17 |

Flash retry aggregate:

- Prompt tokens: `8,119`
- Completion tokens: `17,652`
- Total tokens: `25,771`
- Average total tokens/job: `8,590.3`
- Total elapsed time: `131.741s`
- Average elapsed time/job: `43.914s`
- Raw extracted entities: `51`
- Raw extracted relations: `35`
- New canonical nodes: `18`
- New canonical edges: `33`
- New evidence rows: `34`
- New concept-chunk map rows: `51`
- Cache-miss cost estimate at current DeepSeek V4-Flash pricing: `0.043423 CNY`, about `$0.006079`.

## Metrics

Backfill extraction timing from real LLM calls:

- Successful extraction calls: `6`
- Raw returned entities across successful calls: `118`
- Raw returned relations across successful calls: `98`
- Total successful extraction wall time: `836,079 ms`
- Average extraction wall time: `139,346.5 ms/chunk`
- Min/max extraction wall time: `105,333 ms / 185,043 ms`

Growth metrics:

- Raw entity mentions vs merged canonical nodes: `118 -> 94`
- Raw edge evidence vs canonical edges: `98 -> 96`
- Nodes per processed document: `23.5`
- Edges per processed document: `24.0`
- Evidence per edge: `1.02`

Token and cost metrics:

- The current backfill job path returns provider metrics from `extractGraphFromChunk`, but does not persist or print token usage per job. This is a validation gap.
- The Flash retry script captured real per-job token metrics for the 3 previously failed jobs.
- A real long-chunk stress extraction captured actual DeepSeek metrics:
  - Input tokens: `2,751`
  - Output tokens: `4,934`
  - Total tokens: `7,685`
  - Model: `deepseek-v4-pro`
  - Duration: `89.652s`
- Based on DeepSeek official v4-pro promotional pricing on 2026-05-23 (`3 CNY / 1M input cache-miss tokens`, `6 CNY / 1M output tokens`), the stress call cost estimate is about `0.0379 CNY`.
- If the 6 successful backfill chunks are approximated with the stress-call token profile, successful extraction cost is about `0.227 CNY`. This is an estimate, not an actual billable total.
- Based on DeepSeek official v4-flash pricing on 2026-05-23 (`1 CNY / 1M input cache-miss tokens`, `2 CNY / 1M output tokens`), the 3-job Flash retry cost estimate is about `0.043423 CNY`.

Recommendation: persist `prompt_tokens`, `completion_tokens`, `total_tokens`, `duration`, and `model` on `GraphExtractionJob` or a separate graph metrics table before larger backfills.

## Quality Checks

Entity merge:

- No duplicate `canonicalKey` rows were found in `KnowledgeNode`.
- Merge compression observed: `118` raw entity mentions became `94` canonical nodes.
- Some aliases and semantically close variants still need future semantic merge support; the current v1 canonical merge is working as designed but intentionally lightweight.

Relation ontology:

- All generated `relationType` values were inside ontology v1.
- Distribution:
  - `causes`: `21`
  - `part_of`: `19`
  - `related_to`: `16`
  - `depends_on`: `8`
  - `contrasts_with`: `8`
  - `acts_at`: `8`
  - `used_in`: `6`
  - `regulates`: `6`
  - `precedes`: `3`
  - `implements`: `1`
- Focused utility test confirmed unknown labels downgrade to `related_to` and preserve the raw label as `relationLabel`.

Relation quality sampling:

- Random sample size: `20` real edges with evidence snippets.
- Clearly plausible: `17`
- Questionable relation type: `3`
- Clear hallucination against evidence: `0`

Examples:

- Good: `HP1 depends_on H3K9me3`, evidence: `HP1 binds H3K9me3`.
- Good: `Gene duplication causes Pseudogenes`, evidence repeated across two snippets.
- Questionable: `Hemoglobin implements Cooperative binding`; evidence supports the concept relationship, but `implements` is not the best relation type.
- Questionable: broad `Regulatory DNA related_to Extracellular signal receptors / Protein kinases`; evidence supports proximity/association but relation semantics are weak.

Long chunk stress test:

- Chunk id: `26e727a0-54ba-4226-b15e-a27db29f04a0`
- Document id: `3630fe06-5f74-498e-b5df-67e245bf4408`
- Text length: `5,136`
- Domain: `biology`
- Extracted entities: `20`
- Extracted relations: `7`
- Relation fanout was conservative; no abnormal explosion observed.
- Relation types: `contrasts_with`, `related_to`, `part_of`, `references`
- No obvious relation pollution was observed in the sampled output.

## API, Traversal, Cache, Cleanup

Related concepts API:

```text
GET /api/workspace/1cd3992d-e83f-44dd-a760-28e267b224ba/knowledge/related?concept=Gene%20duplication&includeEvidence=true
```

Initial API result:

- Matched node: `Gene duplication`
- Related nodes: `16`
- Edges: `20`
- Evidence: `21`

Traversal limit checks:

- `maxDepth=1`: `11` nodes, `12` edges
- `maxDepth=99&maxExpandedNodes=999&confidenceCutoff=0`: server caps applied, returned `25` nodes, `30` edges
- `confidenceCutoff=0.95`: `0` nodes, `0` edges
- `maxExpandedNodes=2`: `1` node, `1` edge

Traversal stability:

- Same query repeated 3 times after cache fix returned stable node/edge hash: `99cc9a27d980`.

Cache behavior:

- First validation found a real cache-hit bug: second and third API calls failed because `GraphRetrievalCache` was read with `SELECT *`, causing Prisma raw DateTime deserialization failure on `expiresAt`.
- Fix applied in `server/models/knowledgeGraph.js`: cache reads now select only required columns and avoid returning `expiresAt`.
- Retest on a temporary patched server at port `3002` passed:
  - Repeated calls returned `cache.hit = true`.
  - `GraphRetrievalCache.hitCount` increased to `3`.

Cleanup/decay:

- Before cleanup: `94` nodes, `96` edges, `98` evidence, `5` cache rows.
- After cleanup: `94` nodes, `96` edges, `98` evidence, `0` cache rows.
- Active newly generated graph relations were not deleted.
- Cache invalidation during cleanup worked.

## Vector Retrieval

Vector retrieval was checked after graph backfill:

- Vector namespace exists: `true`
- Vector namespace count: `41`
- Query: `gene duplication chromatin chromosome`
- Returned top 3 sources successfully.
- `document_vectors` content and vector-cache files remained unchanged.
- After Flash retry, `document_vectors` content hash remained unchanged: `d2cc6ce3ab73f96e2ccf09b9d699ff06d51d12b8752f0a0c525fe0da445442dd`.

This confirms the graph pipeline did not regenerate embeddings and did not mutate existing vector storage.

## Validation Commands

Passed:

- `cd /Users/shijie/Desktop/anything-llm/server && npx prisma validate --schema=prisma/schema.prisma`
- `cd /Users/shijie/Desktop/anything-llm/server && npx prisma migrate deploy`
- `cd /Users/shijie/Desktop/anything-llm && yarn test server/__tests__/utils/knowledgeGraph/schema.test.js --runInBand`
- `cd /Users/shijie/Desktop/anything-llm/server && yarn lint:check`
- `cd /Users/shijie/Desktop/anything-llm/frontend && yarn lint:check`
- `cd /Users/shijie/Desktop/anything-llm/frontend && NODE_OPTIONS=--max-old-space-size=4096 yarn build`
- `cd /Users/shijie/Desktop/anything-llm && git diff --check`

Notes:

- Frontend build passed with existing Vite/browserlist/chunk-size warnings.

## Remaining Issues And Risks

- DeepSeek extraction reliability is the biggest observed E2E risk: 3 of 9 jobs failed due to socket timeout or premature close.
- The failed jobs were recoverable by rerunning only failed jobs with `deepseek-v4-flash`.
- The literal alias `deepseek-flash` is not accepted by the current DeepSeek API; use `deepseek-v4-flash`.
- Backfill currently lacks persisted token/cost metrics per job. This should be added before larger backfills.
- Average extraction time was high at about 139s per successful chunk. Large workspaces need conservative concurrency and retry controls.
- Relation quality is mostly usable, but ontology selection can be semantically loose. `implements` in biology contexts should probably be discouraged or remapped.
- Evidence density is low (`1.02 evidence/edge`) because the limited subset is small. Larger backfill is needed before judging multi-evidence explanatory quality.
- Current stage should remain validation-only for retrieval. Do not connect graph into the main retrieval path until extraction reliability, relation quality, and traversal usefulness are observed over more documents.
