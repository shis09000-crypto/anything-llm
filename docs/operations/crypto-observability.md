# Cryptographic observability

Athena exposes cryptographic health through the existing authenticated
Prometheus endpoint. The implementation records registered suite identifiers,
fixed operation families, fixed outcome classes, and aggregate durations only.
It must never record raw key IDs, public keys, signatures, certificate subjects,
device IDs, Vault contents, secrets, or peer hostnames.

Post-quantum controls are registered in the Operations Service Catalog as
`post-quantum-security`. The Node 24 resilience verifier emits only a
metadata-only Semantic Event v1 result. From there the existing Operations
Plane carries it through JetStream and ClickHouse into Timeline and State
Graph. The observe-only Security Agent detects a failed control and returns a
human-review advisory; it has no executable path to rotate keys, change a
suite, reduce a hybrid threshold, or enable a classical fallback.

## Metrics

- `athena_crypto_suite_operations_total` measures registered-suite usage by
  purpose, operation, and outcome. The recording rule
  `athena:crypto_suite:usage_ratio_15m` provides each suite's share.
- `athena_crypto_signature_verification_duration_seconds` separates
  `classical` and `post_quantum` verification latency without identifying a
  signer.
- `athena_crypto_verification_failures_total` uses the bounded reasons
  `invalid_signature`, `corrupt_public_key`, `unknown_suite`,
  `expired_key_id`, `untrusted_key`, `policy_downgrade`,
  `runtime_unavailable`, and `other`.
- `athena_crypto_tls_negotiations_total` records fixed edge/workload/NATS/
  Collector outcome classes. Edge observations are imported from
  `ATHENA_CRYPTO_OBSERVATION_FILE`; the application never changes TLS
  negotiation.
- `athena_crypto_vault_kem_operations_total` records registration, envelope
  storage, and privacy-safe iOS unseal outcomes. Client observations require an
  authenticated, high-risk, hybrid-signed request.
- `athena_crypto_certificate_remaining_seconds` exposes only role, active slot,
  and remaining seconds.
- `athena_crypto_device_epoch_conflicts_total` classifies invalid, stale, and
  conflicting device key epochs.
- `athena_crypto_runtime_pq_capability`,
  `athena_crypto_runtime_pq_capability_expected`, and
  `athena_crypto_runtime_pq_capability_drift` compare the current Node provider
  with the declared fixed-name baseline.

## Runtime baseline

Set `ATHENA_PQ_RUNTIME_EXPECTED_CAPABILITIES` to a comma-separated subset of:

```text
ml_kem_768,ml_dsa_65,encapsulation_api,classical_provider_baseline
```

An unknown name is a configuration error. When no explicit baseline is set,
the classical provider remains mandatory and Node 24 PQ capabilities become
mandatory only when `ATHENA_REQUIRE_NODE24_PQ_PROBE=true`.

## Operational boundaries

- Scrape the API metrics endpoint with its existing bearer credential.
- The Collector metrics endpoint remains protected by its network and mTLS
  boundary when service identity is enabled.
- Configure the edge observation file on the API role only.
- Alert labels are deliberately low-cardinality. Do not add tenant, user,
  device, certificate serial, key ID, request ID, or hostname labels.
- A metric is diagnostic evidence, not an authorization input. Authentication,
  signature verification, certificate validation, and Vault epoch enforcement
  remain fail-closed even if Prometheus is unavailable.
