class TradingPairDetailHubService {
  constructor({ adapter }) {
    this.adapter = adapter;
  }

  snapshot(params = {}) {
    return this.adapter.tradingPairDetail(params);
  }
}

module.exports = {
  TradingPairDetailHubService,
};
