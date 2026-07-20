# Athena P0 Security Upgrade — First Full Matrix (v2.3)

- Started: 2026-07-20 Asia/Shanghai
- Branch baseline: `codex/v2.3` at `2bd6e486b60b45ab3e6a97bdce522cb94c4e551c`
- Rule: finish the entire first matrix and record every failure before changing implementation code.
- Secret policy: use existing local credentials only where required; never print, modify, or rotate key material.

## Matrix

| Gate | Status | Evidence / defect |
|---|---|---|
| SQLite Main/Auth additive migration | pass | `20260720153000_add_auth_realtime_tickets` applied to both authoritative development databases; existing key files untouched. |
| SQLite/PostgreSQL Prisma schema validation | partial | PostgreSQL schema passed. Direct SQLite validation command lacked `DATABASE_URL`; recorded as MATRIX-HARNESS-001, not an implementation finding. |
| Server + Collector Jest full suite | fail | P0-DEF-001: `rag-memory` imported `eventLogRepository` one directory too high; affected two workspace history cases and the WeChat webhook suite. Other observed suites, including new realtime/Collector tests, passed. |
| Frontend Node test suite | fail | 387/396 passed; P0-DEF-002 caused all 9 Agent WebSocket cases to fail because the temporary ESM fixture did not stub/copy the new `realtimeTicketClient` dependency. Crypto ticket regression passed. |
| Sync durability fault injection | fail | 18 functional tests passed; P0-DEF-003 stopped `syncV2Mutations` during module collection because realtime auth eagerly resolved `DataAccessCenter.authIdentity` against a narrow test repository stub. |
| DB, key-custody, data-access, maintainability, supply-chain audits | partial | DB quick/foreign-key, key custody (921 files/0 findings), and data-access (694 files/0 additions) passed. P0-DEF-004: two pre-existing/user-owned iOS God Files exceed their stored line baselines by 19/21 lines. MATRIX-HARNESS-002: Collector audit registry socket hang-up; reachable Critical remains 0 for completed Server/Frontend audits. |
| Server/Frontend/Collector lint | fail | P0-DEF-005: obsolete `SystemSettings` binding remains in `syncCenter.js`; server lint stopped before downstream frontend/Collector lint. |
| Frontend production build + bundle budget | pass | 5,545 modules; initial 826,882 B raw / 234,983 B gzip; budget passed; largest approved lazy chunk 1,723,025 B. |
| Docker Compose config + Collector image build | blocked | MATRIX-ENV-001: local host has no `docker` CLI (`command not found`); neither Compose semantics nor image build can execute in this environment. |
| iOS build and tests | pass | Full `xcodebuild test` completed with `** TEST SUCCEEDED **`, including Sync/cache concurrency and the pre-existing local iOS changes. |
| Live/ready/internal-diagnostics runtime smoke | fail | Developer API entered a nodemon crash loop from P0-DEF-001, so `/live`, `/ready` and protected diagnostics were unavailable; Collector remained HTTP 200. This is the same registered import defect, not a new finding. |

## Defect register

### MATRIX-HARNESS-001 — test command did not provide SQLite `DATABASE_URL`

- Scope: validation harness only.
- Evidence: PostgreSQL validation passed and both SQLite `migrate deploy` runs loaded/validated the same schema successfully; the trailing direct Prisma invocation failed before schema evaluation with P1012.
- Action after the first matrix: rerun SQLite validation through `prisma-runtime.js validate` or provide the normalized read-only URL.

### P0-DEF-001 — invalid EventLogRepository relative import in RAG memory plugin

- Severity: P0 release blocker / deterministic module-load failure.
- Evidence: Jest cannot resolve `../../../../../repositories/eventLogRepository` from `server/utils/agents/aibitat/plugins/memory.js`.
- Blast radius: any route loading the ephemeral Agent plugin registry, observed in developer workspace history and WeChat webhook tests.
- Planned correction after first matrix: change only the repository import depth and rerun the affected suites plus the RAG-memory suite.

### P0-DEF-002 — Agent WebSocket Node fixture lacks realtime ticket dependency

- Severity: test/release blocker; production bundling has not yet been evaluated by this matrix.
- Evidence: 9/9 Agent WebSocket tests fail at ESM module resolution for the temporary fixture's `./realtimeTicketClient`; remaining 387 frontend Node tests pass.
- Planned correction after first matrix: inject a deterministic `issueRealtimeTicket` stub into the existing transformed test fixture and assert the WebSocket URL contains `realtimeTicket` but never a raw JWT.

### P0-DEF-003 — realtime auth module eagerly resolves optional repository surfaces

- Severity: release/test blocker and avoidable module coupling.
- Evidence: `syncV2Mutations.test.js` exits before tests because its intentionally narrow `DataAccessCenter` mock does not expose `authIdentity.model`.
- Planned correction after first matrix: resolve AuthIdentity/User only inside the multi-user identity path (or update the test boundary only if lazy loading cannot preserve repository ownership), then rerun the Sync mutation and realtime suites.

### P0-DEF-004 — iOS maintainability baselines exceeded in user-owned files

- Severity: release governance blocker, outside the P0 security code overlap.
- Evidence: `WorkspaceCenter.swift` 4,064 > 4,045 and `ConversationHomeView.swift` 5,027 > 5,006.
- Ownership note: both files were already modified by the user before this P0 implementation; no reset or blind baseline expansion is permitted.
- Planned action after first matrix: inspect the changes and either extract cohesive helpers without altering the user's behavior or report the non-overlap blocker explicitly.

### MATRIX-HARNESS-002 — Collector dependency audit registry interruption

- Evidence: Yarn audit endpoint returned `socket hang up`; Server/Frontend completed with Critical=0 and known High inventory.
- Planned action after first matrix: rerun only the supply-chain gate after implementation defects are closed.

### P0-DEF-005 — obsolete Sync Center binding fails lint

- Severity: release blocker, no runtime behavior impact.
- Evidence: `server/endpoints/syncCenter.js:31` declares unused `SystemSettings` after broadcast authentication moved to the authoritative principal adapter.
- Planned correction after first matrix: remove only that binding and rerun Server lint, then the remaining Frontend/Collector lint gates.

### P0-DEF-006 — Collector P0 changes need canonical formatting

- Severity: release/lint blocker, no runtime behavior impact.
- Evidence: after P0-DEF-005 was removed, the previously unreachable Collector lint stage reported three Prettier-only findings in `processSingleFile/index.js` and `downloadURIToFile/index.js`.
- Planned correction: format only the two affected files, then rerun the same lint gate.

### P0-DEF-007 — iOS same-key cache deduplication remains scheduling-sensitive

- Severity: reliability/release blocker; discovered during the post-fix iOS direct smoke.
- Evidence: the extracted policy/type files compiled successfully and 52 directly related tests passed, but `BackendFoundationTests.testServerStateCacheDeduplicatesConcurrentFetches()` failed once after approximately 0.6 seconds.
- Scope: unrelated to the type extraction; the same cache race had been observed before this P0 batch.
- Planned action: run only this test under repeated scheduling, inspect the in-flight ownership boundary, and fix either the implementation race or the test barrier before the final matrix.

### MATRIX-ENV-001 — Docker runtime unavailable

- Evidence: both canonical Compose config commands exit 127 because `docker` is not installed/on PATH.
- Impact: container mount/network/image runtime proof cannot be produced locally; this does not change static code correctness.
- Planned action: run YAML/static policy validation locally and keep the Docker-capable staging gate mandatory before release.

## Post-fix closure before final gate

- P0-DEF-001 closed: RAG repository import corrected; 21 affected RAG/workspace/WeChat tests passed and the developer API recovered from its crash loop.
- P0-DEF-002 closed: Agent WebSocket fixture now issues a deterministic one-time ticket, waits for asynchronous socket creation, and asserts no raw JWT query parameter; 9/9 tests passed.
- P0-DEF-003 closed: realtime repositories are resolved lazily at the ownership boundary; 13 Sync/Realtime tests passed.
- P0-DEF-004 closed without baseline expansion: Workspace lifecycle enums and Conversation policies were extracted into file-system-synchronized Swift files. Governed files are now 4,044/4,045 and 4,913/5,006 lines; maintainability audit passed.
- P0-DEF-005 and P0-DEF-006 closed: obsolete binding removed and Collector P0 files formatted with the Collector ESLint configuration; Server/Frontend/Collector lint passed.
- P0-DEF-007 closed: xcresult proved the failure was lexical-order scheduling (`[99, 99]` rather than `[42, 42]`), not duplicate execution. The test now establishes an explicit first-fetch barrier; the exact test passed five consecutive iterations.
- MATRIX-HARNESS-001 closed: normalized `prisma-runtime.js --env development validate` selected the authoritative development SQLite database and passed.
- MATRIX-HARNESS-002 closed: with an extended registry timeout the complete supply-chain policy passed; Server/Collector/Frontend Critical findings are all zero and every reachable High has an active owner/mitigation/expiry policy.
- MATRIX-ENV-001 remains an environment limitation: all four Compose YAML files parse and both Collector service policies pass static fail-closed assertions, but image construction still requires a Docker-capable staging runner.
- Runtime evidence passed: `/live` and `/ready` expose only their exact public contracts; `/ready` was healthy, anonymous diagnostics returned 401, Collector returned 200, an authoritative Session issued a one-time ticket, first WS use reached `broadcast.ready`, and replay closed with code 1008. Test sessions were revoked after the smoke.

## Final-gate findings requiring targeted closure

- P0-DEF-008: four Agent resource-access tests still construct the legacy websocket principal boundary. The implementation now authenticates through `authenticateRealtimeRequest`; the tests must inject an authoritative principal and assert the current 1008 reason semantics before exercising workspace/bridge ownership.
- P0-DEF-009: two transport-security tests still expect the historical TLS 1.2 minimum. The P0 production policy intentionally defaults direct HTTPS to TLS 1.3, so the redacted status and HTTPS boot assertions must be raised to TLS 1.3.
- MATRIX-HARNESS-003: PostgreSQL schema validation ran root `npx`, which downloaded Prisma 7.8 and rejected the repository's Prisma 5 datasource syntax. Validation must run from `server/` with its pinned local CLI; this is a harness error, not a schema defect.
- Passed portions of the interrupted final gate: Frontend Node 396/396; full iOS build/test; SQLite schema validation. Server/Collector Jest reached 1,364/1,370 before the six stale expectations. The composite audit/build chain stopped at MATRIX-HARNESS-003 before mutating any data.

## Post-final-gate integrity finding and closure

- P0-DEF-010: the post-gate fingerprint comparison proved that the supervised development API restart at 22:27:04 rotated `ipc-priv.pem` and `ipc-pub.pem`. The writer was the legacy `new CommunicationKey(true)` boot path, which intentionally regenerated both files on every process start. No key content was printed. The pre-restart pair had no matching local backup, so the report does not claim a fabricated restoration.
- P0-DEF-010 closed: bootstrapping now initializes only when both files are absent; incomplete, mismatched, concurrent, or destination-changing initialization fails closed. Existing pairs are cryptographically validated and private/public permissions are enforced as 0600/0644 without rewriting contents. Four lifecycle regressions passed, a real nodemon hot reload logged `Validated existing RSA key pair without rotation`, and the complete 261-suite/1,373-test Server + Collector matrix preserved content hash, mtime and size exactly.
