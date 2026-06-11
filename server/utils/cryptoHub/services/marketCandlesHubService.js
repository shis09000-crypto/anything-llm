class MarketCandlesHubService {
  constructor({ adapter, sseHub, topics }) {
    this.adapter = adapter;
    this.sseHub = sseHub;
    this.topics = topics;
  }

  topic(params = {}) {
    return this.topics.MARKET_CANDLES(params);
  }

  snapshot(params = {}) {
    return this.adapter.marketCandles(params);
  }

  subscribe(response, params = {}) {
    return this.sseHub.proxyLegacyStream({
      topic: this.topic(params),
      response,
      subscribe: (proxyResponse) =>
        this.adapter.subscribeMarketCandles({
          response: proxyResponse,
          ...params,
        }),
    });
  }
}

module.exports = {
  MarketCandlesHubService,
};
