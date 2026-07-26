# Athena Crypto Suite Registry

Athena resolves cryptographic algorithms by purpose-scoped suite identifiers in
`server/utils/security/cryptoSuiteRegistry.js`. Business modules must not select
algorithms directly.

## Contract

Every suite declares `suiteId`, `purpose`, `classicalAlgorithm`, `pqAlgorithm`,
`parameterSet`, `keyEncoding`, `signatureEncoding`, `minimumClientVersion`,
`status`, `notBefore`, and `deprecatedAfter`. Runtime-only fields map an accepted
suite to its protocol prefix and implementation.

Suite identifiers are purpose scoped. A legacy alias such as `ed25519` is valid
only when the caller also supplies the expected purpose, so an audit signature
cannot be accepted as release evidence or a request signature.

## Lifecycle

Use this progression for a new suite:

1. Register it as `planned`. Planned and disabled suites are never selected or
   verified.
2. Add implementation and cross-language test vectors.
3. Set `minimumClientVersion` and `notBefore`, then move it to `active`.
4. Keep the previous suite as `compatibility` during the rollout window.
5. Set `deprecatedAfter`. Verification fails closed after that time unless a
   narrowly scoped migration tool explicitly opts into historical verification.
6. Move the suite to `disabled` only after retained records no longer require
   online verification or an immutable verification runtime is archived.

Do not activate a post-quantum or hybrid suite merely because it is registered.
Athena's server-side ML-DSA-65, iOS 26 P-256 + ML-DSA-65, Vault X-Wing,
X25519MLKEM768 edge TLS and workload mTLS suites are active only behind their
purpose-specific production gates. The Web PQ credential suite remains
`planned` until browser and FIDO interoperability is mature.

## Current boundaries

- Session JWT creation and verification use the registry's explicit JOSE
  allowlist. Tokens using another algorithm are rejected even with the correct
  secret.
- Device request signatures and device key identifiers resolve through the
  registry. Web has a local compatibility projection; iOS consumes the server's
  bootstrap projection and keeps a fallback for old servers.
- New security-audit checkpoints and release evidence use canonical suite IDs.
  Historical records that say `ed25519` remain verifiable through purpose-scoped
  aliases.
- APNs remains ES256 because Apple defines that protocol, but selection is still
  represented as an Athena suite so the exception is visible and auditable.
- Collector IPC uses persisted RSA signatures and a locally mounted payload
  root; request headers never transport private or symmetric key material. New
  source payloads use HKDF-SHA256 + AES-256-GCM. Legacy AES-CBC reads are
  disabled by default and may be opened only for an audited migration window.
- Production security-audit checkpoints use a two-of-two Ed25519 + ML-DSA-65
  envelope. Edge release evidence and disaster-recovery evidence use the same
  two-family policy and independent trust anchors. Development remains
  classical-compatible when PQ key files are intentionally absent.
- iOS 26 high-risk mutations sign one canonical request with both Secure
  Enclave P-256 and ML-DSA-65. Partial hybrid headers, suite substitution,
  first-use key-binding races and downgrade attempts fail closed.
- Vault device enrollment persists its P-256, ML-DSA-65 and X-Wing private
  material as one device-only protected bundle. UMK/VMK distribution uses
  X-Wing encapsulation, HKDF-SHA256 domain separation, AES-256-GCM and a
  dual-signed envelope bound to registered source and target devices.
- The User Root Key contract keeps three layers separate. The root is random
  256-bit material; HKDF-SHA256 derives isolated Data, File and Agent keys using
  the stable Auth user ID and root-key epoch; the existing Vault X-Wing suite
  only wraps that root for an authorized target device. A password-derived KEK
  or KEM shared secret must never be persisted or reused as the User Root Key.
  Phase 1 stores only Root epoch metadata, a SHA-256 Root commitment and opaque
  X-Wing envelopes in Shared Auth. Envelope v2 includes a dual-signed 256-bit
  challenge and its hash so a receiving device has no out-of-band dependency.
  Root plaintext remains in protected client storage. Existing users remain `not_initialized` until an authenticated,
  hybrid-signed device creates epoch 1; the server never generates a Root.
  Existing UMK/VMK ciphertext is not altered in this phase.
- Collector, Realtime Gateway and Background Worker identities use TLS 1.3
  mTLS certificates with environment-scoped SPIFFE URI SANs. Production NATS
  additionally checks the client certificate/key pair and workload identity.
- External Agent Registry snapshots and remote Capability Manifests use
  ML-DSA-65 provenance signatures. Short-lived per-invocation capability
  credentials remain HMAC-based to avoid adding PQ overhead to the hot path.
- Production edge TLS is terminated by the standard X25519MLKEM768 TLS 1.3
  group with X25519 retained only as an explicit compatibility cohort.

## Asset inventory and runtime gates

`server/utils/security/cryptoAssetInventory.js` is the global non-secret
inventory. It records ownership, purpose, suite references, key source/location,
confidentiality horizon, lifecycle, PQ readiness and source boundaries. Legacy
algorithms remain visible until migration is complete; they are not deleted from
the inventory to make the posture look healthier.

Run these gates from `server/`:

```bash
yarn crypto-agility:audit
yarn crypto-assets:audit
yarn crypto-runtime:verify
yarn crypto-hybrid:verify
yarn edge-tls:evaluate
```

The runtime CI matrix preserves Node 18 and 22 compatibility and separately
requires ML-KEM-768 and ML-DSA-65 on Node 24. Hybrid TLS is evaluated only at an
approved edge proxy; Athena application code does not modify TLS negotiation.

Run `yarn crypto-agility:audit` from `server/` before release. The check rejects
suite literals outside approved registries and JWT verification without an
algorithm allowlist.

Production activation, rollback and key-custody requirements are documented in
`docs/post-quantum-production-runbook.md`.
