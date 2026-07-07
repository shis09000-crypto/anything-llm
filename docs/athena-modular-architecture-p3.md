# Athena Modular Architecture P3

P3 introduces the durable Reader Worker queue. It keeps the monolith path safe
by default while giving modular deployments a real handoff point for Reader
preview, thumbnail, classification, and postprocess work.

## Runtime Shape

- API remains the default executor unless `ATHENA_READER_WORKER_QUEUE=true`.
- Reader Worker polls `reader_worker_jobs` only when the same flag is enabled.
- The queue is accessed through `DataAccessCenter.readerWorkerJob`; worker code
  does not touch Prisma directly.
- The worker calls the existing Reader runtime `runReaderPostprocessJob`, so
  DOCX/MD preview, PDF manifest, thumbnail, classification, broadcast, and
  postprocess status behavior remain shared with the monolith.

## Queue Contract

`reader_worker_jobs` stores:

- `jobId`, `task`, `status`, `priority`, `intent`
- `workspaceSlug`, `readerDocumentId`, `userId`
- small JSON payload with requested task names and category metadata
- retry/lock timestamps and final result/error summaries

It must not store:

- original document text or bytes
- `originalUrl`, absolute paths, cookies, authorization headers
- sensitive session tokens or debug grants

## Enabling Modular Handoff

Set the flag on both API and Reader Worker:

```bash
ATHENA_READER_WORKER_QUEUE=true
```

Then run:

```bash
yarn dev:reader-worker
```

or the modular compose P3 override:

```bash
docker compose \
  -f docker/docker-compose.modular.yml \
  -f docker/docker-compose.modular-p3.yml \
  up -d --build
```

If API cannot enqueue into the durable queue, it falls back to the existing
in-process queue and marks the response with
`durableQueue.mode = "fallback-in-process"`.

## Health And Debug

Reader Worker exposes:

- `GET /health`: liveness only
- `GET /snapshot`: redacted role, queue, task, and preview engine status

`GET /drain-once` is disabled unless `READER_WORKER_DEBUG_HTTP=true`.

## Rollout Guidance

1. Keep `ATHENA_READER_WORKER_QUEUE=false` during normal monolith deploys.
2. Run migrations and Prisma generate before enabling P3.
3. Enable the flag in a staging modular deployment with API and Reader Worker
   together.
4. Watch `DataAccessCenter.snapshot().byDomain.readerWorkerJob` and Reader
   Worker `/snapshot` for queued/running/failed counts.
5. Only after the queue is stable should upload/open/manual Reader postprocess
   work be moved to the dedicated Reader Worker in production.
