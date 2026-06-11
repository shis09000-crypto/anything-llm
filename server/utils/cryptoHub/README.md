# Crypto Data Hub

Crypto Data Hub is the read-only data center for Athena / AnythingLLM crypto
components. Frontend components should use `/api/crypto-hub/*` instead of
calling scattered `/api/crypto/gate/*` endpoints directly.

## Safety boundary

- Hub is read-only only.
- Do not add order, cancel, close-position, withdraw, transfer, leverage,
  take-profit, or stop-loss APIs here.
- API key, secret, Gate `KEY`, `SIGN`, encrypted secrets, and raw auth payloads
  must never be returned to frontend or SSE clients.
- Existing Gate signing, secret loading, sanitizer, and read-only checks are
  reused from `server/utils/cryptoGate`.

## REST APIs

- `GET /api/crypto-hub/status`: Gate config status, public/private REST/WS
  status, service status, subscriber counts, and watchdog topic health.
- `POST /api/crypto-hub/init`: idempotent initialization. It checks Gate env,
  warms public market data, starts shared private WS/polling when possible, and
  preloads only lightweight service snapshots.
- `GET /api/crypto-hub/loading-progress`: unified entry progress for the crypto
  area.
- `GET /api/crypto-hub/equity-history?window=today&equityMode=api_total&sinceTs=...`
  returns today's total-asset history.
- `GET /api/crypto-hub/allocation?quote=USDT` returns spot/earn allocation.
- `GET /api/crypto-hub/open-futures-positions` returns open futures positions.
- `GET /api/crypto-hub/market-candles?market=spot&pair=BTC_USDT&range=1d&beforeTs=...`
  returns market candles and cache metadata.
- `GET /api/crypto-hub/trade-records?from=...&to=...&limit=50&cursorTs=...`
  returns trade records using lazy pagination.
- `GET /api/crypto-hub/trade-records/fee-summary?from=...&to=...&includeYear=true`
  returns fee summary.
- `GET /api/crypto-hub/trading-pair-detail?market=spot&pair=BTC_USDT`
  returns holding, price, and average-buy data for one pair.
- `GET /api/crypto-hub/btc-summary?range=1d` returns the BTC spot card data.

## SSE APIs

- `GET /api/crypto-hub/open-futures-positions/stream`
- `GET /api/crypto-hub/market-candles/stream?market=spot&pair=BTC_USDT&range=1d`
- `GET /api/crypto-hub/trade-records/stream?from=...&to=...&limit=50`

SSE payload shape:

```json
{
  "type": "snapshot|update|status|error|heartbeat",
  "topic": "crypto.openFuturesPositions",
  "asOf": 1710000000000,
  "data": {},
  "freshness": null,
  "safeErrorMessage": null
}
```

Use `data` as the old component payload. `topic` identifies the source:

- `crypto.equity`
- `crypto.allocation`
- `crypto.openFuturesPositions`
- `crypto.tradeRecords`
- `crypto.marketCandles.{market}.{pair}.{range}`
- `crypto.tradingPairDetail.{market}.{pair}`
- `crypto.btcSummary`

## Watchdog recovery

Hub uses two read-only watchdog layers:

- Backend topic watchdog: `CryptoHubSseHub.proxyLegacyStream` records
  subscriber count, last payload, upstream disconnect time, recovery time, and
  recovery count for each topic. If a legacy upstream stream closes or errors
  while subscribers remain active for more than 5 seconds, Hub restarts that
  upstream subscription. A 10 second cooldown prevents repeated reconnect
  storms.
- Frontend component watchdog: `CryptoHubWatchdogProvider` on the crypto
  experiment page lets real-mode components register `{ key, active, status,
  reconnect }`. If a component remains `degraded`, `disconnected`, or `error`
  for more than 5 seconds, the provider calls the component's existing reconnect
  path. Mock mode does not register, and hidden pages pause forced reconnect
  until the tab becomes visible again.

`GET /api/crypto-hub/status` exposes only safe watchdog metadata:
`watchdog.enabled`, `thresholdMs`, `cooldownMs`, and per-topic
`subscriberCount`, `status`, `lastPayloadAt`, `disconnectedSince`,
`lastRecoveryAt`, `recoveryCount`, and `safeErrorMessage`. It must never expose
raw Gate payloads, API keys, secrets, `KEY`, `SIGN`, or signatures.

## Initialization contract

Recommended frontend flow:

1. Call `POST /api/crypto-hub/init` when entering the crypto experiment page.
2. Poll `GET /api/crypto-hub/loading-progress`.
3. Enter the page when phase is `ready` or `degraded`, or after a bounded
   timeout.
4. Let each component fetch its own data through Hub APIs.

`tradeRecords` init only checks availability and may prewarm the first page
(`limit=50`). Full 30-day history must remain lazy-loaded by the component via
`cursorTs` pagination.

## Legacy compatibility

First-stage migration keeps old `/api/crypto/gate/*` endpoints. Those routes
delegate to `CryptoDataHub` so existing pages keep running while new components
move to `/api/crypto-hub/*`.
