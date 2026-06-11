class EquityHubService {
  constructor({ adapter }) {
    this.adapter = adapter;
  }

  start() {
    this.adapter.startEquityPolling();
    return this.adapter.startPrivateWs();
  }

  stopPolling() {
    this.adapter.stopEquityPolling();
  }

  async history(params = {}) {
    return this.adapter.equityHistory(params);
  }

  async prewarm() {
    this.adapter.startEquityPolling();
    return this.adapter.recordEquitySnapshot("hub_init");
  }

  freshness() {
    return this.adapter.equityFreshness();
  }
}

module.exports = {
  EquityHubService,
};
