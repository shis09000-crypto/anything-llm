class TradeRecordsHubService {
  constructor({ adapter, sseHub, topics }) {
    this.adapter = adapter;
    this.sseHub = sseHub;
    this.topics = topics;
  }

  snapshot(params = {}) {
    return this.adapter.tradeRecords(params);
  }

  feeSummary(params = {}) {
    return this.adapter.tradeRecordsFeeSummary(params);
  }

  subscribe(response, query = {}) {
    return this.sseHub.proxyLegacyStream({
      topic: this.topics.TRADE_RECORDS,
      response,
      subscribe: (proxyResponse) =>
        this.adapter.subscribeTradeRecords(proxyResponse, query),
    });
  }

  async prewarmFirstPage() {
    const nowSec = Math.floor(Date.now() / 1000);
    return this.snapshot({
      from: nowSec - 30 * 24 * 60 * 60,
      to: nowSec,
      limit: 50,
    });
  }
}

module.exports = {
  TradeRecordsHubService,
};
