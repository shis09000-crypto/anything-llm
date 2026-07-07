# Athena Modular Architecture P4: Realtime Gateway Prep

## Status

P4 establishes a deployable Realtime Gateway boundary without changing the
default production traffic path. The current default remains:

```text
Web -> API -> in-process Broadcast Center
```

The optional split path is now available for controlled experiments:

```text
Web -> Realtime Gateway -> Broadcast Center
Web -> API -> business endpoints
```

This is intentionally a prep layer. Cross-instance realtime correctness still
requires an external broadcast transport such as Redis or NATS.

## Added Boundaries

- `server/realtime-gateway.js`
  - Owns `/api/sync/events` and `/api/realtime/broadcast` when deployed.
  - Reuses the same auth, client identity, request-signing, SSE, and WebSocket
    endpoint code as the API process.
  - Exposes `/health` and `/snapshot`.

- `server/utils/realtimeGateway/`
  - Provides runtime snapshot and health state for the gateway role.

- `server/utils/broadcast/transportRegistry.js`
  - Makes broadcast transport explicit.
  - `memory` is the only active V1 transport.
  - `redis` and `nats` are reserved and reported as unsupported until adapters
    are implemented.

## Deployment Shape

Docker now includes:

- `realtime-gateway-build`
- `ATHENA_RUNTIME_ROLE=realtime-gateway`
- `REALTIME_GATEWAY_PORT=3013`
- optional compose profile `realtime-gateway`

The Web nginx template has a separate realtime upstream:

```text
ATHENA_API_UPSTREAM=http://anything-llm-api:3001
ATHENA_REALTIME_UPSTREAM=http://anything-llm-api:3001
```

The default realtime upstream intentionally points at the API. To test the
gateway profile, set:

```text
ATHENA_REALTIME_UPSTREAM=http://anything-llm-realtime-gateway:3013
```

## Responsibilities

Realtime Gateway owns:

- Broadcast WebSocket connection lifecycle
- Sync Center SSE compatibility endpoint
- subscription/ack/replay surface
- transport snapshot reporting

Realtime Gateway does not own:

- Chat SSE
- Agent WebSocket
- Crypto market WebSocket
- data loading
- ServerStateCache decisions
- TaskScheduler decisions
- Sensitive Session token storage

## Transport Contract

The active V1 transport is `memory`, which means:

- in-process fanout works
- in-process coalescing works
- in-process replay ring buffer works
- a standalone gateway is isolated from API-published events unless both share
  an external transport

The registry makes this explicit in snapshots:

```json
{
  "selected": "memory",
  "ready": true,
  "gatewaySafe": true,
  "active": {
    "adapter": "memory",
    "multiInstance": false
  }
}
```

If `ATHENA_BROADCAST_TRANSPORT=redis` or `nats` is selected before an adapter is
implemented, publish attempts are rejected and counted as transport errors.

## Verification

Use:

```bash
yarn build:realtime-gateway
yarn check:modular-p4
```

Targeted runtime checks:

```bash
cd server
ATHENA_RUNTIME_ROLE=realtime-gateway NODE_ENV=development node realtime-gateway.js
curl http://localhost:3013/health
curl http://localhost:3013/snapshot
```

## Next Split Candidates

Before routing production traffic to an independent gateway, implement one of:

- Redis pub/sub + stream replay adapter
- NATS JetStream adapter

Then validate:

- API-published events reach gateway-connected clients
- gateway ack/replay survives gateway restart
- `sync.required` is emitted on replay gaps
- profile/avatar/thread/reader events still trigger cache refresh through the
  frontend Broadcast reducer
