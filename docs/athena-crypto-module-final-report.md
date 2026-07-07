# Athena Crypto Module Final Report

## Conclusion

Crypto has been separated into a backend Crypto module with thin HTTP endpoint
adapters and a frontend module entrypoint. This is a code-boundary
modularization, not a microservice split. Existing public routes, response
shapes, admin permissions, dev auth bypass behavior, Gate credential handling,
and stream contracts remain unchanged.

## Current Architecture

```text
HTTP
  server/endpoints/cryptoCenter.js
  server/endpoints/cryptoHub.js
  server/endpoints/cryptoGateProbe.js
    -> server/modules/crypto/httpAdapter.js
      -> httpCenterHandlers
      -> httpHubHandlers
      -> httpGateHandlers

Runtime
  server/modules/crypto/index.js
    -> server/modules/crypto/runtime.js
      -> CryptoRuntime.center
      -> CryptoRuntime.hub
      -> CryptoRuntime.gate
      -> CryptoRuntime.config
      -> CryptoRuntime.streams
      -> CryptoRuntime.diagnostics
      -> CryptoRuntime.background

Internal Consumers
  server/repositories/cryptoRepository.js
  server/utils/BackgroundWorkers/index.js
    -> server/modules/crypto

Frontend
  main route / prefetch
    -> frontend/src/modules/crypto
      -> Crypto Center page
      -> Crypto communication clients
      -> Crypto Hub hooks
      -> cryptoServerStateStore
```

## Module Responsibilities

- `httpAdapter`: preserves route registration compatibility.
- `httpCenterHandlers`: Crypto Center config, snapshot, and WebSocket routes.
- `httpHubHandlers`: Crypto Hub query and SSE routes.
- `httpGateHandlers`: Gate legacy/probe routes.
- `runtime`: stable facade for Hub/Gate/Center/background/status.
- `frontend/src/modules/crypto`: public frontend entrypoint for Crypto UI,
  communication clients, hooks, and server-state cache.

## Unified Center Integration

### TaskScheduler

Crypto does not own frontend scheduling. UI requests still go through existing
communication clients and TaskScheduler policies.

### ServerStateCache

Crypto API results remain cached at the frontend server-state layer. The module
does not make cache authority decisions.

### DataAccessCenter

`CryptoRepository` now reads redacted status and recent events through
`CryptoRuntime`. Settings persistence still flows through the existing
DataAccess/AdminSystem paths.

### Broadcast Center

Broadcast remains a small event system. Crypto market data and stream payloads
stay on Crypto Hub/Gate stream routes, not Broadcast events.

### Recovery Center

Frontend Crypto clients keep existing safe error handling. Runtime errors are
returned through the same safe response envelopes.

### Background Worker

Background Crypto Hub refresh starts and stops through
`CryptoRuntime.background`, not direct Hub singleton imports.

## Security Boundary

- Gate API key/secret remain behind existing secret provider behavior.
- WebSocket token and dev bypass behavior are unchanged.
- DataAccess/dev snapshots use redacted/sanitized status and events.
- The module does not broadcast secrets, large market payloads, or raw
  credential material.

## Verification

Primary checks:

```bash
yarn build:crypto-module
cd server && npx jest __tests__/utils/cryptoGate/openFuturesPositions.test.js __tests__/utils/cryptoGate/secretProvider.test.js __tests__/utils/cryptoGate/tradeRecordCycles.test.js __tests__/utils/cryptoGate/tradeRecords.test.js __tests__/utils/cryptoHub/backgroundRuntime.test.js __tests__/utils/cryptoHub/cryptoHub.test.js __tests__/repositories/p2DataAccessRepositories.test.js __tests__/utils/cryptoModuleBoundary.test.js --runInBand
cd frontend && node --test src/lib/communication/crypto/cryptoClients.node.test.mjs
yarn check:modules
git diff --check
```
