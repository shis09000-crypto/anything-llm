# Platform Key Closure (Phase 4)

Phase 4 is a fail-closed retirement workflow. It never treats a migration job
finishing as permission to retire a platform key.

## Mandatory gates

A key may be retired only when all of the following are true:

1. The registry and custody provider both expose the key as `decrypt_only`.
2. Platform-key references are zero, including encrypted database fields,
   document/vector wrappers, LanceDB wrappers, user-domain fallback metadata,
   and security-audit checkpoints that still derive their verification key
   from the platform key.
3. Every active local user is linked to a shared identity, every shared user
   has an active User Root Key, and every eligible data, file, and vault key
   has an active user-domain wrapper.
4. Device/recovery, Agent/headless, and backup/restore evidence is recorded as
   passed, bound to the exact decrypt-only key and environment, generated
   after observation started, and still within its validity window.
5. The decrypt-only observation period has elapsed with zero successful reads.
6. Legacy `enc:v1` writes have been closed by the persistent write policy.

Production enforces a minimum 30-day decrypt-only observation period. The
development default is 24 hours. `ATHENA_KEY_DECRYPT_ONLY_OBSERVATION_MS`
cannot reduce the production minimum.

Evidence is valid for at most seven days in production and 24 hours in
development. Generate final evidence near the end of the observation window.
`ATHENA_KEY_CLOSURE_EVIDENCE_MAX_AGE_MS` may shorten, but cannot extend, the
production maximum.

## Evidence generation

Run Agent/headless and lattice-KEM checks with the Node 24 crypto runtime:

```bash
yarn key-closure:evidence --kind agent-headless --key-id <old-key-id> \
  --output ../output/security/key-closure/agent-headless.json
```

Run the real SQLite recovery drill with the same Node ABI used by the server,
then validate the restored databases:

```bash
yarn security:drill --execute --key-id <old-key-id>
yarn key-closure:evidence --kind backup-restore --key-id <old-key-id> \
  --source <drill-result.json> \
  --output ../output/security/key-closure/backup-restore.json
```

Backup evidence passes only when both databases were physically restored,
SQLite integrity checks pass, the exact closure key passes a custody round
trip, and every encrypted database, file, LanceDB, and provider-backup value
is readable.

The device/recovery evidence combines the X-Wing user-domain protocol drill
with live user, active-device, synchronized-envelope, and recovery-package
coverage:

```bash
yarn user-domain-wraps:e2e --execute \
  --output ../output/security/key-closure/device-protocol-e2e.json
yarn key-closure:evidence --kind device-recovery --key-id <old-key-id> \
  --source ../output/security/key-closure/device-protocol-e2e.json \
  --output ../output/security/key-closure/device-recovery.json
```

Failed evidence remains useful diagnostic output, but `record-evidence`
rejects it and does not create a passing governance event.

Evidence generation and recording both reject active keys. Start the workflow
only after rotation has placed the source key in `decrypt_only`.

## Closure sequence

All mutations require `--apply --execute` and an explicit environment.

```bash
yarn key-closure audit --key-id <old-key-id>
yarn key-closure record-evidence --key-id <old-key-id> \
  --kind agent-headless --evidence <evidence.json> \
  --apply --execute --env <environment>
yarn key-closure start-observation --key-id <old-key-id> \
  --apply --execute --env <environment>
yarn key-closure close-legacy-writes --key-id <old-key-id> \
  --apply --execute --env <environment>
yarn key-closure retire --key-id <old-key-id> \
  --apply --execute --env <environment>
```

`start-observation` rejects active keys. `close-legacy-writes` recomputes every
gate before writing the irreversible policy. `retire` generates fresh
migration and closure proofs, verifies both again inside Key Custody, and uses
the recoverable state transition `decrypt_only → retiring → retired`. It first
records `retiring`, then replaces the mutable env-file provider entry with a
metadata-only tombstone and removes its key material, and finally records
`retired`. If the process stops after material destruction, the next invocation
reconciles the tombstone into the registry instead of attempting decryption
again. Subsequent resolution and decryption are impossible. External KMS/Vault
providers must provide equivalent provider-side destruction semantics.

## Read-hit handling

Successful decrypts through a `decrypt_only` key are appended to a private
hash-chained JSONL observation log and increment
`athena_decrypt_only_key_reads_total{key_id,domain,runtime_role}`. Resource
identifiers are hashed before persistence.

The observation start event stores a random observation identifier mirrored in
the log. Missing logs, missing start markers, malformed records, or a broken
hash chain block closure even when the apparent read count is zero.

Restored databases and evidence under `output/security/drills/` and
`output/security/key-closure/` are ignored by Git because they can contain
sensitive production-shaped data. Files are created with mode `0600` inside
directories with mode `0700`.

Security-audit checkpoint verification is also a key read because legacy
checkpoints derive their trusted Ed25519 public key from the platform key. Such
checkpoints must be migrated to independently trusted public verification keys
before the platform key can be retired.
