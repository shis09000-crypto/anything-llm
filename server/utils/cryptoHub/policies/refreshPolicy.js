const refreshPolicy = {
  equity: {
    cacheReadMs: 500,
    restNormalMs: 2_000,
    restSlowMs: 30_000,
    persistMs: 60_000,
  },
  allocation: { restRefreshMs: 60_000 },
  openFuturesPositions: {
    restFallbackMs: 2_000,
    streamBroadcastThrottleMs: 500,
  },
  marketCandles: {
    restCacheTtlMs: 5_000,
    restFallbackMs: 2_000,
    staleAfterMs: 4_000,
    streamBroadcastThrottleMs: 250,
  },
  tradeRecords: {
    defaultWindowDays: 30,
    batchLimit: 50,
    streamReconnectMs: 5_000,
  },
  tradingPairDetail: {
    normalRefreshMs: 5_000,
    hiddenRefreshMs: 30_000,
    slowRefreshMs: 30_000,
  },
};

module.exports = {
  refreshPolicy,
};
