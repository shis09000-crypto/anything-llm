const CryptoHubTopics = {
  EQUITY: "crypto.equity",
  ALLOCATION: "crypto.allocation",
  OPEN_FUTURES_POSITIONS: "crypto.openFuturesPositions",
  TRADE_RECORDS: "crypto.tradeRecords",
  MARKET_CANDLES: ({ market = "spot", pair = "BTC_USDT", range = "1d" }) =>
    `crypto.marketCandles.${String(market).toLowerCase()}.${String(pair)
      .trim()
      .toUpperCase()}.${String(range).trim().toLowerCase()}`,
  TRADING_PAIR_DETAIL: ({ market = "spot", pair = "BTC_USDT" }) =>
    `crypto.tradingPairDetail.${String(market).toLowerCase()}.${String(pair)
      .trim()
      .toUpperCase()}`,
  BTC_SUMMARY: "crypto.btcSummary",
};

module.exports = {
  CryptoHubTopics,
};
