# Athena 14-Risk Closure — First Full Matrix Defect Ledger (v2.3)

Date: 2026-07-20 (Asia/Shanghai)

This ledger was frozen after the first complete matrix. No product defect below was repaired before the remaining Server, Frontend, Collector, iOS, database, policy, maintainability, supply-chain and bundle gates finished.

## Registered defects

| ID | Gate | Failure | Classification | Planned targeted verification |
|---|---|---|---|---|
| R14-D01 | Development schema deploy | SQLite authority was held by the running API; Prisma migration exited with `database is locked` before the new device-key handshake migration was applied. | Runtime coordination / deployment | Graceful stop, explicit development migration, restart and `/live` + `/ready` verification; compare protected key files before/after. |
| R14-D02 | Frontend Node suite | The browser high-risk request matcher did not include the two new device-key rotation routes. Result: 395/396. | Cross-language security contract drift | Update the shared browser matcher and rerun only `requestSigningClient.node.test.mjs`. |
| R14-D03 | Server lint | `system.js` still uses bcrypt for the ephemeral legacy `AUTH_TOKEN` challenge after the credential import was removed. | Import regression, not password-storage regression | Restore the compatibility-only import and rerun Server lint plus the directly related middleware/system tests. |
| R14-D04 | Key custody boundary audit | The local DR drill implemented AES-GCM directly outside the custody boundary (two findings). | Architecture boundary violation | Move the isolated round-trip probe into Key Custody and rerun custody audit + DR drill. |
| R14-D05 | iOS full suite | The simulator exposes an emulated Secure Enclave, so the test incorrectly required `p256-software-v1`; runtime correctly emitted `p256-secure-enclave-v1`. | Test assumption / platform capability | Assert the governed algorithm set and add opaque-reference persistence coverage; rerun the single iOS test and security smoke. |
| R14-D06 | Protected-file post-migration verification | Provider settings hydration treated byte-identical values as newly applied and rewrote `.env.development` solely to refresh its generated timestamp comment. Keyring, IPC and TLS key material remained byte-identical. | Idempotency / false key-change signal | Skip equal environment values before deciding to persist; prove the real development restart leaves all protected files stable. |
| R14-D07 | Final Sync V2 shadow audit | `users/3/security/clients` diverged after a device-key security transition while the client rollout flag was disabled. The existing materialized shadow node was not maintained because write-side projection updates were incorrectly coupled to read-side rollout. | Control-plane coupling / stale security projection | Preserve zero-overhead ordinary requests, but transactionally maintain an already-materialized security client node for key enrollment, key rotation and revocation even before client rollout; repair the one stale node and re-audit. |

## First-matrix evidence

- Server + Collector: 265 suites, 1,392/1,392 tests passed.
- Frontend Node: 395/396 passed; one contract failure registered as R14-D02.
- iOS: build succeeded; one assertion failure registered as R14-D05.
- Frontend production build: passed; initial 826,882 B raw / 234,985 B gzip; largest approved lazy chunk 1,723,025 B.
- Frontend and Collector lint: passed. Server lint: two `bcrypt is not defined` findings registered as R14-D03.
- Data access: 697 files, zero bypasses/additions; model error semantics zero; endpoint status zero.
- S0–S4 catalog: 52 domains, five levels, zero findings.
- Main/Auth database integrity: `quick_check=ok`, foreign-key violations zero.
- Local DR dry-run: both databases valid and Key Custody lookup/decrypt round-trip passed; boundary audit failure registered separately as R14-D04.
- Maintainability and supply-chain gates: passed; Critical vulnerabilities zero under the governed reachability policy.
- PostgreSQL schema validation and Frontend bundle budget: passed.

Fix policy: after this ledger, only each defect and its directly related smoke tests are rerun. R14-D06 was discovered during the required protected-file check and was appended before the final gate. A second complete matrix runs once after every registered defect closes.

## Targeted closure evidence

| ID | Status | Evidence |
|---|---|---|
| R14-D01 | Closed | Development supervisor stopped gracefully; the device-key migration applied exactly once to Main and shared Auth stores; both databases report `quick_check=ok` and zero foreign-key violations; HTTPS API, frontend proxy and HTTP Collector returned healthy after restart. |
| R14-D02 | Closed | `requestSigningClient.node.test.mjs`: 7/7 passed, including both prepare and commit high-risk paths. |
| R14-D03 | Closed | Compatibility-only bcrypt import restored for the legacy `AUTH_TOKEN` challenge; targeted Server ESLint and related identity/request-signing tests passed. Stored user credentials remain Argon2id with bcrypt verify-only migration. |
| R14-D04 | Closed | AES-GCM recovery probe moved behind Key Custody; boundary audit scanned 927 files with zero findings; local DR dry-run validated Main/Auth integrity and custody round-trip. |
| R14-D05 | Closed | iPhone 17 / iOS 26.5 targeted build and test succeeded; the test accepts only the governed software or Secure Enclave P-256 algorithm identifiers. |
| R14-D06 | Closed | Provider hydration now marks equal values `unchanged`; regression test passed; after the real nodemon restart, `.env.development`, Keyring, IPC keys and TLS key/cert metadata and content remained stable. |
| R14-D07 | Closed | Write-side shadow maintenance is now independent from read-side cohort rollout for device-key enrollment/rotation/revocation when the node already exists. Targeted tests passed 37/37; the authoritative repair updated one node, and the follow-up audit reports 186 projections, zero Hash mismatch, zero projection conflict and zero inaccessible node. The later lifecycle seal decoupled the internal dispatcher as well, so the repair event is now drained even while client rollout is disabled. |

Targeted regression result: Web 7/7; Server 55/55 across nine suites plus targeted ESLint; iOS 1/1; Key Custody audit zero; development runtime healthy. The final complete matrix is now authorized by the frozen-ledger protocol.
