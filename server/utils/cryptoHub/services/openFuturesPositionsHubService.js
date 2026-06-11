class OpenFuturesPositionsHubService {
  constructor({ adapter, sseHub, topics }) {
    this.adapter = adapter;
    this.sseHub = sseHub;
    this.topics = topics;
  }

  snapshot() {
    return this.adapter.openFuturesPositions();
  }

  subscribe(response) {
    return this.sseHub.proxyLegacyStream({
      topic: this.topics.OPEN_FUTURES_POSITIONS,
      response,
      subscribe: (proxyResponse) =>
        this.adapter.subscribeOpenFuturesPositions(proxyResponse),
    });
  }
}

module.exports = {
  OpenFuturesPositionsHubService,
};
