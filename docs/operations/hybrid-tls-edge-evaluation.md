# Hybrid TLS edge evaluation

Athena does not terminate or customize application TLS in the Node service. A post-quantum TLS experiment must remain at an approved edge proxy or CDN and must not change REST, WebSocket, SSE, APNs, Collector IPC, or client certificate validation.

## Evaluation boundary

- Use an isolated edge hostname and a deterministic client cohort.
- Prefer the provider's supported X25519 + ML-KEM-768 hybrid group. Do not implement a private TLS extension in Athena.
- Preserve TLS 1.3, certificate validation, HSTS and secure WebSocket behavior. X25519 compatibility is a separate edge listener; a strict PQ cohort never silently falls back inside the same listener.
- Measure handshake bytes, p50/p95 latency, failure rate, CPU and client/version coverage.
- Never route authentication, Vault or production writes through the experiment until the rollback and compatibility gates pass.

Run the read-only probe with:

```bash
ATHENA_EDGE_HYBRID_TLS_EVALUATION_HOST=pq-edge.example.test \
ATHENA_CRYPTO_OBSERVATION_FILE=/var/lib/athena/crypto-observations.json \
  node server/scripts/evaluate-hybrid-tls-edge.js \
    --require-hybrid --cohort=1 --client-class=ios26
```

The observation file contains bounded cumulative counts and at most 1,000 sanitized samples. Samples contain only the fixed cohort, fixed client class, outcome/reason, negotiated group, certificate boolean, duration, TTFB and CPU ratio. It never contains hostnames, certificates, client identities, key identifiers, public keys, signatures or key material. Configure the same file read-only in the API runtime so `/metrics` can expose counters and histograms.

## Promotion gate

Summarize a cohort into a promotion evidence file:

```bash
node server/scripts/summarize-hybrid-tls-evidence.js \
  --observation-file=/var/lib/athena/crypto-observations.json \
  --cohort=1 --baseline-ttfb-ms=180 \
  --cdn-supported=true --load-balancer-supported=true --envoy-supported=true \
  > /var/lib/athena/edge-evidence-1.json
```

Promotion is dry-run by default and only supports `0 → 1 → 5 → 25 → 100`:

```bash
node server/scripts/manage-hybrid-tls-rollout.js promote \
  --to=1 --evidence=/var/lib/athena/edge-evidence-1.json \
  --state-file=/var/lib/athena/edge-rollout.json

# Add --execute only after the dry-run is reviewed.
```

The state file is a desired edge weight artifact: the CDN/load balancer routes that percentage to `athena-pq-edge-strict` and the remainder to the compatibility listener. Athena application processes never read this artifact for authorization or use it to bypass the PQ gate. Rollback may target any lower fixed stage and is also dry-run unless `--execute` is present.

# Production profile

The production edge profile defines two isolated TLS policies. `athena-pq-edge-strict` accepts only `X25519MLKEM768`; `athena-pq-edge` remains the explicit X25519MLKEM768/X25519 compatibility endpoint for clients outside the cohort. The CDN/LB, not application code, owns deterministic cohort routing.

Certificate and private-key files are mounted read-only. This repository does
not generate, rotate, or copy production edge keys.
