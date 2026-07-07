# Athena Modular Architecture P2

P2 turns the optional modular deployment into four process roles:

- Web static frontend
- API-only backend
- Collector service
- Background Worker service

Reader Worker remains an optional process boundary until a durable Reader job
queue is introduced.

## Default Path Is Still Unchanged

`docker/docker-compose.yml` continues to run the classic monolith. P2 only affects
`docker/docker-compose.modular.yml` and explicit runtime roles.

## Modular Runtime Roles

| Role | Entrypoint | Purpose |
| --- | --- | --- |
| `monolith` | `server/index.js` + collector inline | Current production-compatible default |
| `api` | `server/index.js` | API/Auth/DataAccess/Sensitive/DevControl without static SPA or background workers |
| `collector` | `collector/index.js` | Document parsing/scraping/OCR collector |
| `background-worker` | `server/background-worker.js` | Bree jobs, scheduled jobs, cleanup, patrol, crypto background refresh |
| `reader-worker` | `server/reader-worker.js` | Reader process boundary and future job executor |

API role defaults:

- `ATHENA_API_ONLY=true`
- `ATHENA_BACKGROUND_INLINE=false`
- `ATHENA_COLLECTOR_INLINE=false`

This prevents duplicate scheduled jobs when the modular background worker is
running.

## Modular Compose

```bash
cd docker
docker compose -f docker-compose.modular.yml up -d --build
```

Default services:

- `anything-llm-web`
- `anything-llm-api`
- `anything-llm-collector`
- `anything-llm-background-worker`

Optional service:

```bash
docker compose -f docker-compose.modular.yml --profile reader-worker up -d --build
```

## Health Surfaces

- API: `/api/ping`
- Web: nginx static service on `:3000`
- Collector: `/accepts`
- Background Worker: `/health`, `/snapshot`
- Reader Worker: `/health`, `/snapshot`

## P2 Boundary Guarantees

- API does not serve SPA assets in modular mode.
- API does not run `BackgroundService` in modular mode.
- Collector is addressed through `COLLECTOR_ENDPOINT=http://anything-llm-collector:8888`.
- Background Worker uses the same storage mount and database state as API, but
  owns Bree/maintenance job execution.
- Reader Worker does not yet execute durable jobs. It exposes readiness and
  preview engine state only.

## Checks

```bash
yarn check:modules
yarn build:reader-worker
yarn build:background-worker
yarn check:modular-p2
```

Docker Compose validation requires a host with Docker:

```bash
docker compose -f docker/docker-compose.modular.yml config
```

## Next Step

P3 should introduce a durable Reader job queue/table and move preview,
thumbnail, classification, page-preview, and postprocess execution from the API
process to the Reader Worker.
