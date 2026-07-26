# AI operations consumer recovery — 2026-07-25

## Incident

The `athena-operations-clickhouse` durable consumer stopped advancing after
stream sequence 657. Valid semantic events were repeatedly redelivered while
ClickHouse was saturated by its own trace-level diagnostic tables and failed
inserts. The application continued publishing to NATS, but the ClickHouse
timeline became incomplete without clearly reporting that degradation.

The recovery preserved the semantic-event business table and NATS stream. Only
backed-up `system.*_log` diagnostic tables were removed.

## Repair

- ClickHouse now runs with warning-level file logging, high-frequency system log
  tables disabled, and bounded background merge concurrency.
- Semantic events are inserted in confirmed JSONEachRow batches (up to 256
  events, 1 MiB, or one second), with async-insert confirmation before ACK.
- The durable consumer uses bounded ACK pending, `working()` heartbeats, a
  process-wide exponential circuit breaker, and a persistent DLQ for permanent
  decode/schema failures.
- Timeline and health responses expose source completeness, persisted position,
  stream/ACK position, lag, redeliveries, and degraded state. Timeline reads
  fall back to bounded NATS scans when ClickHouse is unavailable.
- Golden-journey and OperationContext alert ratios are traffic-gated and use
  window increases, so no traffic is no-data rather than a zero-percent SLO.
- The public timeline contract exposes `redeliveries` while retaining the
  internal `redelivered` compatibility field.

## Recovery evidence

- Full ClickHouse volume backup:
  `/data/anythingllm/backups/aiops-fix-20260725T2018/clickhouse-volume-before-repair.tar`
  - Size: 985 MiB
  - SHA-256: `0be4e095f4ade0c4513c4ca55d671d9b1ebed59488c5d6ea8059457abed2b7af`
- Main database backup before removal of known synthetic WSS probe clients:
  `/data/anythingllm/backups/aiops-fix-20260725T2018/main-db-before-wss-probe-cleanup.sqlite`
  - Size: 465 MiB
  - SHA-256: `22786615747d47b7bb7e5952475342e044dc81e18c2141a9b50dd92f7107630b`
- Pre-repair evidence:
  `/data/anythingllm/backups/aiops-fix-20260725T2018/evidence`
- ClickHouse data directory reduced from about 1.3 GiB to 53–66 MiB after
  diagnostic-log cleanup. The business table retained all 1,284 unique events.
- Synthetic cleanup removed exactly 74 `client_codex_*` client rows and one
  associated nonce in one transaction. No real client, session, sync cursor,
  ticket, push token, or business record was removed.

## Production acceptance

- Final API image:
  `sha256:725b047e834c395907620f3ef214f919e5ddb5a1eb6172cdd6d3e52568fa1a84`
- Final API start:
  `2026-07-25T13:15:22.442785712Z` (`2026-07-25 21:15:22` Asia/Shanghai)
- API container became healthy with restart count zero; public `/api/ping` and
  `/api/setup-complete` returned HTTP 200.
- NATS stream last sequence and consumer ACK floor were both 1,319. Lag,
  ACK-pending, redeliveries, and DLQ were all zero.
- Dry-run reconciliation compared 1,284 retained unique event IDs with 1,284
  ClickHouse event IDs: zero missing and zero invalid messages.
- Timeline returned `source=clickhouse`, `degraded=false`,
  `completeness=complete`, `lag=0`, and `redeliveries=0`.
- Authenticated public WSS acceptance returned signing-secret HTTP 200,
  realtime-ticket HTTP 201, `broadcast.ready`, and signed
  `broadcast.hello ok=true`, with no signature warning.
- Prometheus API and OpenTelemetry targets were UP. The API-switch transient
  error-rate alert cleared without firing; no SLO no-traffic alert remained.
- ClickHouse held 1,284 business events and reported no error code 241 or 252.
  A post-recovery sample used 66.09 MiB of the 768 MiB limit.
- API logs since the final switch contained zero `P2028`, `P2002`,
  `MEMORY_LIMIT_EXCEEDED`, `signature_mismatch`, ClickHouse 241, or ClickHouse
  252 matches.
- Final continuous observation completed after 30 minutes with the API healthy,
  restart count zero, all queues caught up, reconciliation clean, and no active
  Prometheus alerts.

## Verification

- Operations-plane unit regression: 4/4 passed.
- Request-signing WebSocket regression: 31/31 passed.
- Prometheus rule tests covered no-data, static counters, success-only,
  failure-only, incomplete OperationContext coverage, and no-traffic sync.
- Targeted lint and `git diff --check` completed without code or formatting
  errors.
