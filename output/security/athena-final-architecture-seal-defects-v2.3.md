# Athena Final Architecture Seal — Defect Ledger (v2.3)

Date: 2026-07-21 (Asia/Shanghai)

This ledger records the defects discovered by the final architecture review and
the first closing-matrix capture. Defects found during that capture were fixed
and verified only with directly related smoke tests; one final complete gate is
run after every row below is closed.

| ID | Finding | Risk | Closure | Verification |
|---|---|---|---|---|
| SEAL-D01 | Sync shadow nodes could write Outbox events while client Sync V2 was disabled, but the dispatcher lifecycle was coupled to the client flag. | A durable event could remain permanently pending and a client enabling V2 later could miss the notification side chain. | Internal Outbox dispatch now has an independent shadow mode, mandatory active mode and readiness contract. | Real development Outbox drained through seq 705 with client rollout still disabled; pending/retrying/claimed/DLQ all zero. |
| SEAL-D02 | PostgreSQL clients and schemas existed, while several runtime table/column probes and DDL paths still used SQLite-only `PRAGMA`, `AUTOINCREMENT`, `last_insert_rowid()` and date functions. | A PostgreSQL deployment could appear supported until a production path failed or silently diverged. | Added provider-aware schema introspection, migration-owned table checks, dialect boundary gates and provider-neutral Repository operations. | PostgreSQL schema generation/validation and 46 provider/migration regression tests passed; dialect audit reports zero findings. |
| SEAL-D03 | Thread read cursor monotonicity depended on SQLite `json_extract` over a state payload that may be encrypted; the read-before-write guard was also race-prone and not PostgreSQL compatible. | Concurrent devices could regress a read cursor or fail after encrypted state adoption. | Added additive `monotonicCursor`, atomic database UPSERT guard and authoritative projection overlay for SQLite and PostgreSQL. | Migration applied to Main/Auth development stores; concurrency, encrypted-state and stale-projection tests passed. |
| SEAL-D04 | Nineteen model catch paths were still governed as silent fallback debt; database and key-custody failures could look like empty data, single-user mode or encryption-not-configured. | False health, security-default drift and plaintext fallback on custody failure. | Converted authority/data paths to typed `503 database_operation_failed`, removed encryption exception downgrades, made parsed-file reads partial and observable, and retained only four explicit input-level fail-closed fallbacks. | Fault-injection tests, maintainability audit (`4/4`), model error audit and full Jest matrix passed. |
| SEAL-D05 | The supply-chain release gate performed one remote Yarn advisory query per component and treated transient registry resets as a terminal result without bounded retry metadata. | Flaky external audit availability could block releases without distinguishing retry exhaustion from a policy violation. | Added bounded exponential retry only for classified transport failures, attempt evidence, and fail-closed exhaustion. | Three deterministic retry-policy tests and the real three-component gate passed; reachable Critical remains zero. |
| SEAL-D06 | A CLI declared as read-only still loaded the ordinary Prisma SQLite runtime, which can negotiate WAL/journal state and touch database metadata. | Audit execution could violate operator expectations even without a business write. | Read-only bootstrap now freezes `ATHENA_CLI_DATABASE_ACCESS=read`, opens Main/Auth/inspectors with SQLite `mode=ro`, skips write PRAGMAs and never creates directories. | Bootstrap tests passed; a production Chat dry-run preserved database size, mtime and SHA-256 exactly. |
| SEAL-D07 | Chat object migration had mandatory backup semantics but no disk-capacity preflight. The 1.01GB production database currently has only about 1.32GB free. | Backup plus rewrite/WAL could exhaust disk and interrupt user data. | Added capacity accounting for backup, database rewrite and 512MiB reserve; execute fails before backup when insufficient. | Capacity tests passed; production dry-run reports 2.55GB required, 1.32GB available and `executeReady=false`; no production write was attempted. |

## Expected release blockers, not product defects

- Enterprise edge and cross-region disaster-recovery evidence is absent in the
  local development environment. The release gate correctly fails closed; no
  evidence is generated or forged by repository code.
- Docker is not installed on this host. Compose/image and real
  PostgreSQL/NATS/S3 multi-instance fault tests remain mandatory in CI or a
  Docker-capable staging environment.
- Empty legacy SQLite artifacts with nested environment paths predate this
  final seal. The shared CLI bootstrap rejects these paths and no new nested
  database was created. They are preserved because the approved scope forbids
  deleting user/runtime data.

## Final complete gate

- Server/Collector: 269 suites and 1,417 tests passed.
- Web: 396 tests passed; production bundle and budget gate passed.
- iOS/iPadOS: 102 tests passed on iPhone 17 Simulator.
- Sync shadow: 263 nodes and 186 projections; zero permission, payload, Hash or
  projection conflict; Outbox pending/retrying/claimed/DLQ are all zero.
- Main/Auth SQLite integrity, PostgreSQL schema validation, Chat Hash Chain,
  security ledger, route hardening, desktop isolation, supply-chain policy,
  runtime health and Git whitespace gates passed.
- All eight protected environment, keyring, IPC and local TLS files remained
  byte-for-byte unchanged with unchanged timestamps and permissions.

The first frontend health probe omitted `Accept: text/html`, so Vite correctly
returned 404 instead of applying SPA fallback. A browser-equivalent probe
returned 200 for Web, API ping, liveness, readiness and Collector. This was a
test-harness false positive, not a product defect.
