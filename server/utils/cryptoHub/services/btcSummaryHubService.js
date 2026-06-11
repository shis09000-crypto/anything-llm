class BtcSummaryHubService {
  constructor({ adapter }) {
    this.adapter = adapter;
  }

  snapshot(params = {}) {
    return this.adapter.btcSummary(params);
  }
}

module.exports = {
  BtcSummaryHubService,
};
