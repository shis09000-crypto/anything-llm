# Vault key lifecycle

Athena Vault keeps domain ciphertext in existing Vault records and distributes only UMK/VMK epoch material through hybrid KEM envelopes. The lifecycle plane is metadata-only: it never receives a plaintext UMK, VMK, device private key or recovery secret.

The Phase 1 User Root Key plane reuses the same X-Wing + dual-signature
authorization transport. The persistent Root remains random 256-bit material
and its Data, File and Agent keys are derived separately with HKDF-SHA256.
Neither the password KEK nor the ephemeral KEM shared secret is a Root
derivation input.

Root metadata lives in Shared Auth and is keyed by stable `authUserId`. The
server stores only the epoch, suite identifiers, a SHA-256 Root commitment and
opaque encrypted envelopes. It never receives Root plaintext.

## User Root initialization and device authorization

1. A hybrid-signed device reads Root status. Existing accounts without a Root
   receive `not_initialized`.
2. The device requests a one-time, five-minute, 256-bit initialization
   challenge.
3. After a fresh Vault reauthentication grant, the client generates a random
   256-bit Root, protects it in device secure storage, and creates an X-Wing
   self-envelope bound to the stable Auth identity, device generation, Root
   epoch and challenge.
4. Shared Auth atomically consumes the challenge and creates exactly one active
   epoch-1 commitment. A competing different Root fails closed.
5. To add a device, an existing Root-holding device requests an authorization
   challenge for the registered target generation, creates a new X-Wing
   envelope, and submits it with a fresh Vault grant.
6. Envelope v2 carries the signed challenge value as well as its SHA-256 hash,
   so the target can verify and decapsulate without an out-of-band secret.
7. The target verifies both P-256 and ML-DSA-65 signatures, decapsulates
   locally, validates the Root commitment, stores the Root, and only then marks
   the envelope consumed.

Expired or consumed challenges cannot be reused. Envelopes expire after ten
minutes and are unique per Auth identity, target client generation, and Root
epoch. Challenge issuance is limited to 30 per signed source device per hour.
Device reset therefore requires a new device generation and envelope.

Root rotation and re-encryption of existing data are intentionally excluded
from Phase 1. They require a later migration with per-domain coverage and
rollback evidence; changing the Root commitment in place is forbidden.

On iOS, `UserRootKeyCenter` owns this state machine. Authenticated startup reads
the remote commitment without blocking legacy data. Login & Security exposes
explicit initialization and pending-device receipt. The center derives Data,
File and Agent keys only after the local Root matches the Shared Auth
commitment, and it clears in-memory readiness on sign-out.

## State model

- A device Vault key has a monotonically increasing `keyGeneration`. Historical public registrations remain available to verify already accepted envelopes. Revoking a device revokes all of its registrations without deleting the public audit material.
- A Vault key epoch moves through `staging → active → retiring → retired`. Retirement is a logical state change; it never deletes key material or ciphertext server-side.
- Every active Vault-capable device must acknowledge a new epoch with its current key generation. The optional inventory hash is SHA-256 metadata only and must not contain item names or secrets.
- An old epoch can be retired only after a newer epoch is active, every active device acknowledged it, and a ready encrypted recovery package covers the newer epoch.
- The iOS key rings retain at least two device generations and two UMK/VMK epochs. Local retirement is refused while an envelope or item still references the old generation/epoch.

## Rotation and concurrent authorization

1. Obtain a fresh Vault access grant.
2. Start exactly one next epoch with `POST /api/vault/key-epochs/rotate`.
3. Each active target receives one envelope for that epoch. Different targets can be authorized concurrently; `(user, target, epoch)` remains idempotent.
4. Each device persists the recovered material before calling `POST /api/vault/key-epochs/{epoch}/ack`.
5. The server activates the epoch only after all active Vault devices acknowledge it.
6. Create and verify an offline recovery package before retiring an older epoch.

Epoch creation is limited to one transition every five minutes. Envelope creation is bounded per source device and hour. Epoch jumps, stale writes and overlapping rotations fail closed.

## Lost device and Secure Enclave reset

The recovery secret is generated and retained by the client/user. The server stores only an AES-256-GCM encrypted recovery package derived with HKDF-SHA-256. Recovery requires normal account authentication, a fresh Vault grant and the offline recovery secret.

After recovery:

1. Decrypt and validate all recovery package epochs locally.
2. Create a new Secure Enclave generation greater than the last server generation.
3. Register it through the signed Vault KEM rotation endpoint.
4. Re-envelop the current epoch to the replacement device.
5. Force-revoke the lost/old device. Session revocation and historical Vault public-key revocation occur together.

The client must never silently overwrite an unreadable Secure Enclave archive. A damaged key, enclave reset or device migration enters the explicit recovery path.

## Required drills

- simultaneous authorization of at least five devices for one epoch;
- source and target KEM rotation with historical envelope decryption;
- corrupted PQ private representation and corrupted encrypted recovery package;
- Secure Enclave reset followed by recovery and forced old-device revocation;
- app/OS migration while two epochs remain referenced;
- rate-limit and replay attempts against epoch rotation, envelope submission and recovery access.

No drill may modify production keys. Use isolated test identities and encrypted synthetic UMK/VMK material.
