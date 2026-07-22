# Athena AI Operations Plane: Phase 1

Phase 1 establishes a metadata-only correlation and telemetry substrate. It
does not store prompts, chat text, tool arguments, credentials, signing
material, or model chain-of-thought.

## OperationContext

Every inbound request receives `operationId`, `interactionId`, `requestId`,
`traceId`, and `spanId`. Business layers enrich that context with stable IDs:

- `sourceActionId` for idempotent mutations.
- `clientTurnId` for chat turns.
- `invocationId` and `toolCallId` for Agent execution.
- `workspaceId`, `threadId`, and `clientId` for scoped diagnosis.

The context is carried by `AsyncLocalStorage` and copied into OpenTelemetry
span attributes. Background work receives a new operation ID and must retain
the originating business ID when one exists.

## Semantic Event v1

The authoritative schema is
`server/utils/observability/semantic-event-v1.schema.json`. Events include
state, impact, evidence references, hypotheses, recommendation metadata,
sensitivity, retention, and the OperationContext correlation block. Raw
secrets and user/model content are not accepted by the event builder.

Semantic events are written as structured process logs and exported through
OTLP Logs to Loki. Traces are exported to Tempo; Prometheus scrapes bounded
metrics from the authenticated `/metrics` endpoint.

## Span coverage

| Layer | Span family | Content policy |
| --- | --- | --- |
| DataAccessCenter | `data_access.<domain>.<operation>` | Domain, operation, access type only |
| Prisma | `db.<operation>` | DB system, logical database, model, operation |
| Model | `gen_ai.model.invoke` | Provider, model, task, token counts |
| Agent model | `gen_ai.agent.invoke` | Provider and model only |
| RAG/vector | `rag.<operation>` | Backend and operation only |
| Agent tool | `gen_ai.tool.execute` | Tool name and outcome only |

## Golden journey SLOs

| Journey | Availability target | Primary milestone |
| --- | ---: | --- |
| Login | 99.9% | Authenticated response |
| Chat | 99.0% | First streamed response and final response |
| Agent tool | 98.0% | Tool execution completion |
| Knowledge ingest | 99.0% | Ingest request completion |
| Cross-device sync | 99.5% | Replay/fingerprint/bootstrap completion |

Critical-flow correlation coverage is a separate SLO and must remain at or
above 95%. Prometheus recording and alert rules live in
`docker/observability/slo-recording-rules.yaml`.

## Production startup

Use the normal production compose file with the observability overlay:

```bash
docker compose \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.observability.yml \
  up -d
```

`ATHENA_METRICS_TOKEN_FILE` must point to a host secret file and
`ATHENA_GRAFANA_ADMIN_PASSWORD` must be set. Collector ports are not published;
Grafana binds to loopback by default.
