# Athena Modular Architecture P1

P1 adds optional Web/API/Reader Worker runtime boundaries while preserving the
existing monolith deployment as the default path.

## Default Path Is Unchanged

`docker/docker-compose.yml` still starts the classic `anything-llm` service. The
default Docker target remains `production-build`, which serves the frontend from
the API container and starts collector inline.

## Optional Modular Compose

Use `docker/docker-compose.modular.yml` to try the split boundary locally:

```bash
cd docker
docker compose -f docker-compose.modular.yml up -d --build
```

Services:

- `anything-llm-web`: nginx static frontend on port `3000`, proxying `/api/*`
  and WebSocket upgrades to the API service.
- `anything-llm-api`: Node API on port `3001`, with `ATHENA_API_ONLY=true`, so
  it does not serve the SPA shell.
- `anything-llm-reader-worker`: optional profile service for the Reader Worker
  process boundary.

Start the optional Reader Worker profile:

```bash
docker compose -f docker-compose.modular.yml --profile reader-worker up -d --build
```

## Runtime Roles

`ATHENA_RUNTIME_ROLE` controls the entrypoint:

- `monolith`: default server + inline collector.
- `api`: API-only server. Static frontend is disabled.
- `collector`: collector-only process.
- `reader-worker`: Reader Worker boundary process.

`ATHENA_API_ONLY=true` can also disable production SPA serving without changing
the runtime role.

## Reader Worker Scope

The P1 Reader Worker is a process boundary and health/snapshot surface. Durable
job handoff remains API-owned until the Reader job queue is externalized. This is
intentional: P1 should prove build/runtime separation without changing Reader
business semantics.

Health endpoints:

- `GET /health`
- `GET /snapshot`

## Checks

```bash
yarn check:modules
yarn build:reader-worker
yarn check:modular-p1
```

`check:modular-p1` runs P0 module checks, Web build, API checks, collector checks,
and Reader Worker checks.

## Next Step

P2 should externalize actual Reader job handoff: preview, thumbnail,
classification, page-preview, and postprocess jobs should be persisted in a
durable queue/table before the worker becomes responsible for execution.
