# Athena Crypto Module Boundary

## Current Shape

Crypto is now a backend runtime module with endpoint adapters:

```text
server/endpoints/cryptoCenter.js
server/endpoints/cryptoHub.js
server/endpoints/cryptoGateProbe.js
  -> server/modules/crypto/httpAdapter.js
    -> httpCenterHandlers
    -> httpHubHandlers
    -> httpGateHandlers

server/repositories/cryptoRepository.js
server/utils/BackgroundWorkers/index.js
  -> server/modules/crypto
    -> CryptoRuntime.center
    -> CryptoRuntime.hub
    -> CryptoRuntime.gate
    -> CryptoRuntime.config
    -> CryptoRuntime.streams
    -> CryptoRuntime.diagnostics
    -> CryptoRuntime.background
```

The HTTP API stays compatible. The old endpoint files are compatibility
adapters; crypto business behavior belongs to `server/modules/crypto`.

Frontend crypto entrypoints are grouped at `frontend/src/modules/crypto`:

```text
frontend/src/modules/crypto
  -> lib/communication/crypto
  -> hooks/cryptoHub
  -> utils/serverState/cryptoServerStateStore
  -> pages/Admin/CryptoCenter
```

## Stable Internal Facade

- `CryptoRuntime.center`: mock snapshot and delta stream helpers.
- `CryptoRuntime.hub`: Crypto Hub singleton status, init/start/stop, loading.
- `CryptoRuntime.gate`: Gate status, event buffer, WS/market stream managers,
  REST client, credentials accessor, safe error formatting.
- `CryptoRuntime.config`: redacted config status.
- `CryptoRuntime.streams`: stream implementation surface for Hub/Gate.
- `CryptoRuntime.diagnostics`: redacted status snapshot for DataAccess/dev tools.
- `CryptoRuntime.background`: background refresh lifecycle.

## Boundary Rules

- Endpoint adapters may import `server/modules/crypto`.
- Crypto runtime and utils must not import `server/endpoints/crypto*.js`.
- DataAccess and background workers use `CryptoRuntime`, not endpoint internals.
- Frontend page routing and prefetching enter Crypto through
  `frontend/src/modules/crypto/CryptoCenter`.

## Next Cleanup

`httpCenterHandlers`, `httpHubHandlers`, and `httpGateHandlers` still preserve
the old endpoint body for compatibility. Future cleanups can split those files
by concern without changing public routes:

- config handlers
- center WebSocket handlers
- hub query handlers
- hub stream handlers
- Gate legacy/probe handlers
- diagnostics handlers

Acceptance checks:

```bash
yarn build:crypto-module
yarn check:modules
```
