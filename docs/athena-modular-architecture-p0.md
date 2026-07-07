# Athena Modular Architecture P0

This document records the first modularization step for Athena. P0 does not split
containers or change runtime topology. It makes the current monolith easier to
reason about and prepares safe Web/API/Reader Worker separation later.

## Current Runtime Boundary

- Production still builds one Docker image from `docker/Dockerfile`.
- The final image contains the Vite frontend, the Node API, and collector
  dependencies.
- `docker/docker-entrypoint.sh` starts the API server and collector in the same
  container.
- `server/index.js` owns API endpoints, static frontend serving, WebSocket
  realtime, Reader, Crypto, Developer Control, Sensitive Session, and background
  resume hooks.

## P0 Rules

1. Web code must not import server or collector internals.
2. Collector must not import app endpoints or DataAccess internals.
3. DataAccessCenter and repositories must not depend on API endpoints.
4. Storage providers must not depend on endpoints, Developer Control, or
   Broadcast.
5. Broadcast remains a small event center. It may invalidate or publish small
   status events, but real data must still be loaded through API and cache
   refresh paths.

The machine-readable rule set lives in `docs/athena-module-boundaries.json` and
is checked by `scripts/audit-module-boundaries.mjs`.

## Build Targets

P0 introduces logical build/check targets without changing Docker deployment:

- `build:web`: build the frontend artifact.
- `build:api`: run server syntax/lint/DataAccess checks.
- `build:collector`: run collector checks.
- `check:modules`: audit module boundaries.
- `check:modular-p0`: run module boundaries plus Web/API/Collector checks.

These targets make CI and local work less monolithic before the runtime is split.

## Future Split Order

P1 should split Web and Reader Worker first:

1. Web static artifact or image.
2. API image that keeps Auth, DataAccess, Sensitive Session, Developer Control,
   Workspace, Thread, Chat, and core gates.
3. Reader Worker for preview, thumbnail, classification, and postprocess jobs.

P2 can split Collector and generic Background Worker. P3 can split Broadcast into
a Realtime Gateway if WebSocket scale or multi-instance replay requires it.

## Guardrail

Do not move DataAccess, Sensitive Session issuing, request signing, or Developer
Control auth out of the API service until storage, identity, and audit contracts
are externalized and tested. Those modules are authority boundaries, not early
worker candidates.
