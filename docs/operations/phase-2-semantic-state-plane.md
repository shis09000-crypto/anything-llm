# Athena AI Operations Plane: Phase 2

Phase 2 turns Semantic Event v1 into a durable, queryable system model. It
answers three operational questions without exposing prompts, chat text,
credentials, tool arguments, or model chain-of-thought:

1. What happened?
2. Who or what was affected?
3. Where is the supporting evidence?

## Durable data path

```text
OperationContext
  -> Semantic Event v1 validation
  -> ATHENA_OPERATIONS JetStream
  -> athena-operations-clickhouse durable consumer
  -> ClickHouse semantic_events_v1
  -> timeline / state graph / explain APIs
```

The operations stream is separate from `ATHENA_BROADCAST`. It uses the same
production mTLS and NKey/credentials policy, but has an independent retention
window and consumer. An operations outage cannot fail a user request; events
enter a bounded retry queue and remain available through OTLP logs.
The operations stream is capped at 4 GiB and seven days by default; ClickHouse
retains metadata-only events for 180 days.

## Registries and catalog

- **Schema Registry** is code-authoritative and immutable per
  `name@version`. Every schema has a canonical SHA-256 fingerprint. Unknown
  versions are rejected before JetStream or ClickHouse.
- **Agent Registry** combines code-defined agent identities and capabilities
  with metadata-only invocation state from the existing Agent invocation
  repository. Prompts are never returned.
- **Service Catalog** records component ownership, criticality, capabilities,
  and dependency edges. It is the stable topology used for blast-radius
  traversal.
- **State Graph** overlays Semantic Events, Sync V2 health, and Agent state on
  the catalog. Sync V2 remains the consistency state tree; this graph is a
  diagnostic projection, not a second business authority.

## Read APIs

All endpoints require an authenticated administrator or owner account. In
single-user mode they remain behind the normal authenticated request guard.

| Endpoint                                     | Purpose                                          |
| -------------------------------------------- | ------------------------------------------------ |
| `GET /api/operations/health`                 | JetStream, ClickHouse, retry and rejection state |
| `GET /api/operations/schemas`                | Registered schema versions and fingerprints      |
| `GET /api/operations/schemas/:name/:version` | Immutable JSON schema                            |
| `GET /api/operations/services`               | Service Catalog                                  |
| `GET /api/operations/agents`                 | Agent Registry and safe invocation summaries     |
| `GET /api/operations/timeline`               | Filtered semantic timeline                       |
| `GET /api/operations/state-graph`            | Current diagnostic graph                         |
| `GET /api/operations/explain`                | Structured what/impact/evidence answer           |

Timeline filters are `after`, `before`, `eventId`, `eventType`, `subjectId`,
`operationId`, and `limit` (maximum 500). `explain` requires `eventId` or
`operationId` and returns the primary event, blast radius, evidence references,
hypotheses with confidence/counter-evidence, recommendation metadata, and the
correlated timeline.

## Production activation

Use the normal production compose file with both overlays:

```bash
docker compose \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.observability.yml \
  -f docker/docker-compose.ai-operations.yml \
  up -d
```

The overlay intentionally consumes a managed, PKI-protected NATS deployment;
it does not start an insecure embedded NATS server. Provision the existing
`docker/nats/nats-server.production.conf.example` contract first. ClickHouse is
network-internal and exposes no host port. All five secret files must be mode
`0400` or `0600` before deployment.
