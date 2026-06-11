class TopAssetsHubService {
  constructor({ adapter }) {
    this.adapter = adapter;
  }

  snapshot(params = {}) {
    return this.adapter.topAssets(params);
  }

  prewarm() {
    return this.snapshot({
      limit: 6,
      exclude: "BTC,ETH,USDT,GUSD",
      quote: "USDT",
    });
  }
}

module.exports = {
  TopAssetsHubService,
};
