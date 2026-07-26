# Athena Post-Quantum Production Runbook

This runbook activates the existing hybrid controls. It does not authorize key
rotation, copying production keys into the repository, or weakening a failed
gate.

## Required runtime and custody

- Run API, audit verification, release evidence and Agent Registry signing on
  Node 24 LTS with the default OpenSSL 3.5 provider. Node 18 and 22 remain
  supported for classical compatibility modes only.
- Provision Ed25519 and ML-DSA-65 keys as separate trust anchors. Private keys
  must be non-exportable in the chosen KMS/HSM where supported, or mounted as
  read-only mode-0600 files until the provider adapter is enabled.
- Issue separate TLS 1.3 workload certificates for API, Collector, Realtime
  Gateway and Background Worker. Every certificate must contain exactly the
  expected `spiffe://athena/<environment>/<role>` URI SAN. The configured CA
  bundle must contain the direct issuing CA. Athena verifies the issuer
  signature, validity window, remaining lifetime and private-key match before
  becoming ready.
- Never reuse audit, release, disaster-recovery, Agent Registry, workload TLS or
  edge TLS keys across purposes or environments.

`server/scripts/provision-pq-signing-keys.js` is dry-run by default, refuses to
overwrite files, and is intended only for development or an approved key
ceremony. Existing key files must not be modified in place.

## Preflight gates

Run before enabling production flags:

```bash
node server/scripts/verify-crypto-runtime-capabilities.js --require-node24-pq
node server/scripts/verify-pq-hybrid-interoperability.js
node server/scripts/verify-pq-resilience.js --profile all --ci
node server/scripts/audit-crypto-agility-boundaries.js
node server/scripts/audit-crypto-asset-inventory.js
```

`--require-node24-pq` is intentionally fail-closed: it rejects Node 18, Node
22, unverified future major versions, and Node 24 builds missing ML-KEM-768,
ML-DSA-65, the encapsulation API, or the classical provider baseline.

The resilience verifier uses ephemeral validation keys only and covers:

- the normal path through Ed25519 + ML-DSA-65 verification and
  ML-KEM-768 + HKDF-SHA-256 + AES-256-GCM sealing;
- downgrade, tampered data, corrupt signatures and public keys, expired or
  missing trust anchors, duplicate signers, wrong KEM keys, and damaged KEM
  ciphertext;
- bounded worker concurrency, sustained operations, a multi-megabyte signing
  payload, event-loop delay, resident-memory growth, throughput and p95
  latency.

It also converts the result to the existing AI Operations semantic-event
schema. A failed control is detected by the observe-only security shadow agent;
the operations path cannot rotate a key, alter a suite, or automatically
downgrade the policy. `--emit-operations` starts the configured Operations
Plane, requires its JetStream and ClickHouse path to be ready, publishes the
result durably, and drains the client before exit. A missing or degraded
Operations Plane fails the publication instead of pretending the evidence was
managed. Use `--output <new-file>` to publish an atomic, mode-0600 JSON report;
the command refuses to overwrite an existing report.

For the modular Docker deployment, production backend roles are built on Node
24 while the frontend-only build may remain on Node 18. Apply the enterprise PQ
overlay only after its referenced key and evidence files have been provisioned
by an approved key ceremony:

```bash
docker compose \
  -f docker-compose.modular.yml \
  -f docker-compose.service-mtls.yml \
  -f docker-compose.enterprise-pq.yml \
  config
```

The overlay mounts existing files read-only and never creates, rewrites or
rotates a key. The API remains not-ready when any runtime capability, evidence,
App Attest, external key provider or immutable audit-archive gate is missing.

Generate release or disaster-recovery evidence only through the shared signer:

```bash
cd server
yarn security:evidence:sign --execute \
  --profile disasterRecovery \
  --input /approved/evidence/dr-unsigned.json \
  --output /approved/evidence/dr.json \
  --ed25519-key-id dr-ed25519-2026 \
  --ed25519-private-key /run/secrets/dr-ed25519.pem \
  --mldsa65-key-id dr-mldsa65-2026 \
  --mldsa65-private-key /run/secrets/dr-mldsa65.pem
```

The signer enforces a 2-of-2 Ed25519 + ML-DSA-65 policy, self-verifies the
complete evidence document, refuses to overwrite an existing artifact and
uses atomic file publication. Use separate key IDs and key material for
edge release and disaster-recovery evidence.

Require dual-signed edge and DR evidence, then verify the configured evidence
files with `server/scripts/verify-enterprise-security-evidence.js`. Validate the
edge cohort with `server/scripts/evaluate-hybrid-tls-edge.js --require-hybrid`;
the negotiated group must be exactly `X25519MLKEM768` and certificate validation
must succeed.

## Activation order

1. Enable maker-checker key rotation. A production rotation must be prepared
   by an authenticated operator, approved by a different operator within the
   bounded approval window, and atomically claimed by one executor. Do not use
   the CLI to bypass the approval state machine.
2. Bind every Vault/KMS data-key lease to its environment and exact workload
   SPIFFE audience. Missing lease IDs, provider attestations or audience claims
   are fatal in production.
3. Enable dual signing for release and DR evidence in CI.
4. Enable `ATHENA_AUDIT_HYBRID_SIGNATURES=required` on Node 24 workers.
5. Enable external Agent Registry ML-DSA verification.
6. Deploy workload mTLS with overlapping current/next certificates and verify
   CA issuance, SPIFFE identities, readiness and drain.
7. Enable the X25519MLKEM768 edge cohort, then grow the cohort only while
   classical fallback and handshake failure metrics stay within budget.
8. Deploy the internal Apple App Attest verifier behind TLS 1.3 workload mTLS.
   Its response must bind the App Attest key ID, application ID, environment,
   server `clientDataHash`, full Athena device-key binding hash, monotonic
   assertion counter and expiry. Raw attestations stay out of Athena databases.
9. Enable iOS high-risk hybrid signatures and Vault device key distribution for
   iOS 26 clients in observe mode, verify successful attestations/assertions,
   and only then set `ATHENA_DEVICE_ATTESTATION_MODE=required`. Device-key
   bootstrap routes remain hybrid-signed but attestation-exempt to avoid a
   circular enrollment dependency; all subsequent high-risk operations require
   a live attestation.

App Attest enrollment submissions are stored durably in the device Keychain
until the server confirms them. Later startup checks use App Attest assertions
with a strictly increasing counter. Changing any registered P-256, ML-DSA-65,
hybrid KEM or Vault authorization key invalidates the prior attestation and
requires a new proof.

Web PQ device credentials stay disabled until browser/FIDO support meets the
same persistence, attestation, recovery and cross-version gates.

For a planned workload-certificate overlap, add
`docker/docker-compose.service-mtls-rotation.yml` after the base modular and
service-mTLS compose files. The overlay requires every `*_NEXT_CERT_HOST_FILE`
and `*_NEXT_KEY_HOST_FILE`, mounts them read-only and activates the runtime's
validated current/next selection. Remove the rotation overlay only after every
workload reports the new certificate slot and the old certificate has been
revoked or expired. Normal operation does not require next-certificate files.

## Failure and rollback

- A missing or invalid PQ signature, altered policy threshold, corrupt public
  key, mismatched workload certificate/private key or unexpected TLS group is a
  hard failure.
- Roll back by stopping the affected cohort, not by accepting an incomplete
  hybrid envelope. Already PQ-bound iOS devices remain PQ-required.
- Preserve old public verification keys and signed evidence for their retention
  period. Never delete evidence to make a verification failure disappear.
- No automated rollback may rewrite or rotate keys. Key recovery follows the
  separately approved custody and disaster-recovery ceremony.
