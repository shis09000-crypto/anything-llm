const {
  cryptoGateBtcSpotSummaryService,
  cryptoGateEquityHistoryService,
  cryptoGateMarketCandlesService,
  cryptoGateMarketStreamManager,
  cryptoGateOpenFuturesPositionsService,
  cryptoGateTopSpotAssetsService,
  cryptoGateTradeRecordsFeeSummaryService,
  cryptoGateTradeRecordsService,
  cryptoGateTradingPairDetailService,
  cryptoGateWsManager,
  GateRestClient,
  getGateConfigStatus,
  getGateCredentials,
} = require("../../cryptoGate");

class GateHubAdapter {
  constructor() {
    this.restClientFactory = () => new GateRestClient();
  }

  configStatus() {
    return getGateConfigStatus();
  }

  credentials() {
    return getGateCredentials();
  }

  startPrivateWs() {
    const credentials = this.credentials();
    cryptoGateWsManager.setEventHandler((event) =>
      cryptoGateEquityHistoryService.markDirty(
        `${event?.source || "ws"}:${event?.eventType || "event"}`
      )
    );
    return cryptoGateWsManager.start(credentials);
  }

  stopPrivateWs() {
    return cryptoGateWsManager.stop();
  }

  wsStatus() {
    return cryptoGateWsManager.status();
  }

  startEquityPolling() {
    cryptoGateEquityHistoryService.startPolling();
  }

  stopEquityPolling() {
    cryptoGateEquityHistoryService.stopPolling();
  }

  equityFreshness() {
    return cryptoGateEquityHistoryService.freshness();
  }

  async equityHistory(params = {}) {
    return {
      success: true,
      config: this.configStatus(),
      history: await cryptoGateEquityHistoryService.today(params),
    };
  }

  async recordEquitySnapshot(reason = "hub") {
    return cryptoGateEquityHistoryService.recordSnapshot(reason);
  }

  async allocation({ quote = "USDT" } = {}) {
    const client = new GateRestClient();
    const [spotResult, earnResult, tickersResult] = await Promise.allSettled([
      client.getSpotAccountsRaw(),
      client.getEarnUniLendsRaw(),
      client.getSpotTickersRaw(),
    ]);
    return { spotResult, earnResult, tickersResult, quote };
  }

  async openFuturesPositions() {
    return cryptoGateOpenFuturesPositionsService.snapshot();
  }

  async topAssets(params = {}) {
    return cryptoGateTopSpotAssetsService.topAssets(params);
  }

  subscribeOpenFuturesPositions(response) {
    return cryptoGateOpenFuturesPositionsService.subscribe(response);
  }

  async tradeRecords(params = {}) {
    return cryptoGateTradeRecordsService.snapshot(params);
  }

  subscribeTradeRecords(response, query = {}) {
    return cryptoGateTradeRecordsService.subscribe(response, query);
  }

  async tradeRecordsFeeSummary(params = {}) {
    return cryptoGateTradeRecordsFeeSummaryService.snapshot(params);
  }

  async marketCandles(params = {}) {
    return cryptoGateMarketCandlesService.marketCandles(params);
  }

  subscribeMarketCandles({ response, ...params }) {
    return cryptoGateMarketStreamManager.subscribe({
      response,
      ...params,
    });
  }

  marketStreamsStatus() {
    return cryptoGateMarketStreamManager.status();
  }

  async tradingPairDetail(params = {}) {
    return cryptoGateTradingPairDetailService.detail(params);
  }

  async btcSummary(params = {}) {
    return cryptoGateBtcSpotSummaryService.summary(params);
  }
}

module.exports = {
  GateHubAdapter,
};
