const { safeErrorMessage } = require("../cryptoGate");
const { CryptoHubCache } = require("./cache/CryptoHubCache");
const { CryptoHubRateLimitState } = require("./cache/CryptoHubRateLimitState");
const { GateHubAdapter } = require("./exchange/gateHubAdapter");
const { CryptoHubLoadingProgress } = require("./hubLoadingProgress");
const { CryptoHubState } = require("./hubState");
const { CryptoHubTopics } = require("./hubTopics");
const {
  assertReadOnlyOperation,
  redactSensitive,
} = require("./policies/safetyPolicy");
const { AllocationHubService } = require("./services/allocationHubService");
const { BtcSummaryHubService } = require("./services/btcSummaryHubService");
const { EquityHubService } = require("./services/equityHubService");
const {
  MarketCandlesHubService,
} = require("./services/marketCandlesHubService");
const {
  OpenFuturesPositionsHubService,
} = require("./services/openFuturesPositionsHubService");
const { TradeRecordsHubService } = require("./services/tradeRecordsHubService");
const { TopAssetsHubService } = require("./services/topAssetsHubService");
const {
  TradingPairDetailHubService,
} = require("./services/tradingPairDetailHubService");
const { CryptoHubSseHub } = require("./streams/CryptoHubSseHub");

function gateConnectionStatus(snapshot) {
  if (!snapshot) return "disconnected";
  if (snapshot.status === "connected") return "connected";
  if (snapshot.status === "connecting") return "degraded";
  if (snapshot.status === "error" || snapshot.lastError) return "degraded";
  return "disconnected";
}

function publicWsStatus(marketStreams = []) {
  if (!Array.isArray(marketStreams) || !marketStreams.length) {
    return "disconnected";
  }
  if (marketStreams.some((stream) => stream.status === "connected")) {
    return "connected";
  }
  if (
    marketStreams.some((stream) =>
      ["connecting", "fallback", "error", "disconnected"].includes(
        stream.status
      )
    )
  ) {
    return "degraded";
  }
  return "disconnected";
}

class CryptoDataHub {
  constructor({ adapter = new GateHubAdapter() } = {}) {
    this.adapter = adapter;
    this.cache = new CryptoHubCache();
    this.rateLimitState = new CryptoHubRateLimitState();
    this.state = new CryptoHubState();
    this.loadingProgress = new CryptoHubLoadingProgress();
    this.sseHub = new CryptoHubSseHub();
    this.initInFlight = null;
    this.privateWsStarted = false;
    this.services = {
      equity: new EquityHubService({ adapter }),
      allocation: new AllocationHubService(),
      openFuturesPositions: new OpenFuturesPositionsHubService({
        adapter,
        sseHub: this.sseHub,
        topics: CryptoHubTopics,
      }),
      topAssets: new TopAssetsHubService({ adapter }),
      marketCandles: new MarketCandlesHubService({
        adapter,
        sseHub: this.sseHub,
        topics: CryptoHubTopics,
      }),
      tradeRecords: new TradeRecordsHubService({
        adapter,
        sseHub: this.sseHub,
        topics: CryptoHubTopics,
      }),
      tradingPairDetail: new TradingPairDetailHubService({ adapter }),
      btcSummary: new BtcSummaryHubService({ adapter }),
    };
  }

  start() {
    assertReadOnlyOperation("crypto-hub-start");
    this.state.start();
    this.services.equity.start();
    this.privateWsStarted = true;
    return this.getStatus();
  }

  stopIfIdle() {
    this.services.equity.stopPolling();
    return {
      success: true,
      stoppedPrivateWs: false,
      reason:
        "CryptoDataHub keeps private WS alive for shared read-only subscribers.",
      ws: this.adapter.wsStatus(),
    };
  }

  async init() {
    if (this.initInFlight) return this.initInFlight;
    this.initInFlight = this.runInit().finally(() => {
      this.initInFlight = null;
    });
    return this.initInFlight;
  }

  async runInit() {
    assertReadOnlyOperation("crypto-hub-init");
    this.state.start();
    this.loadingProgress.reset();

    const mark = (key, status, patch = {}) =>
      this.loadingProgress.setItem(key, status, patch);

    mark("publicMarket", "loading");
    try {
      const market = await this.getMarketCandles({
        market: "spot",
        pair: "BTC_USDT",
        range: "1d",
      });
      this.state.markFromPayload("marketCandles", market);
      mark("publicMarket", "ready");
      mark("marketCandles", "ready");
    } catch (error) {
      const message = safeErrorMessage(error);
      this.state.markError("marketCandles", message);
      mark("publicMarket", "error", { safeErrorMessage: message });
      mark("marketCandles", "error", { safeErrorMessage: message });
    }

    mark("privateAccount", "loading");
    try {
      this.start();
      mark("privateAccount", "ready");
    } catch (error) {
      mark("privateAccount", "degraded", {
        safeErrorMessage: safeErrorMessage(error),
      });
    }

    await Promise.allSettled([
      this.initService("equity", "equity", () =>
        this.services.equity.prewarm()
      ),
      this.initService("allocation", "allocation", () => this.getAllocation()),
      this.initService("topAssets", "topAssets", () =>
        this.services.topAssets.prewarm()
      ),
      this.initService("openFutures", "openFuturesPositions", () =>
        this.getOpenFuturesPositions()
      ),
      this.initService("tradeRecords", "tradeRecords", () =>
        this.services.tradeRecords.prewarmFirstPage()
      ),
    ]);

    return {
      success: true,
      status: this.getStatus(),
      loadingProgress: this.getLoadingProgress(),
    };
  }

  async initService(progressKey, serviceKey, loader) {
    this.loadingProgress.setItem(progressKey, "loading");
    this.state.markLoading(serviceKey);
    try {
      const payload = await loader();
      this.state.markFromPayload(serviceKey, payload || { success: true });
      const status =
        this.state.serviceStatus(serviceKey) === "error"
          ? "degraded"
          : this.state.serviceStatus(serviceKey);
      this.loadingProgress.setItem(
        progressKey,
        status === "loading" ? "ready" : status
      );
      return payload;
    } catch (error) {
      const message = safeErrorMessage(error);
      this.state.markError(serviceKey, message);
      this.loadingProgress.setItem(progressKey, "error", {
        safeErrorMessage: message,
      });
      return null;
    }
  }

  getStatus() {
    const config = this.adapter.configStatus();
    const ws = this.adapter.wsStatus();
    const marketStreams = this.adapter.marketStreamsStatus();
    const state = this.state.snapshot();
    return redactSensitive({
      enabled: Boolean(config.enabled),
      readOnly: Boolean(config.readOnly),
      gate: {
        configured: Boolean(
          config.enabled &&
            config.readOnly &&
            config.hasApiKey &&
            config.hasApiSecret
        ),
        privateRest:
          config.enabled &&
          config.readOnly &&
          config.hasApiKey &&
          config.hasApiSecret
            ? "connected"
            : "disconnected",
        privateWs:
          gateConnectionStatus(ws.spot) === "connected" ||
          gateConnectionStatus(ws.futuresUsdt) === "connected"
            ? "connected"
            : gateConnectionStatus(ws.spot) === "degraded" ||
                gateConnectionStatus(ws.futuresUsdt) === "degraded"
              ? "degraded"
              : "disconnected",
        publicRest:
          state.services.marketCandles === "ready" ? "connected" : "degraded",
        publicWs: publicWsStatus(marketStreams),
      },
      services: state.services,
      serviceDetails: state.serviceDetails,
      rateLimits: this.rateLimitState.snapshot(),
      subscribers: {
        total: this.sseHub.subscriberCount(),
      },
      watchdog: this.sseHub.watchdogSnapshot(),
    });
  }

  getLoadingProgress() {
    return this.loadingProgress.snapshot();
  }

  async getEquityHistory(params = {}) {
    const payload = await this.services.equity.history(params);
    this.state.markFromPayload("equity", payload?.history || payload);
    return payload;
  }

  async getAllocation(params = {}) {
    const payload = await this.services.allocation.snapshot({
      quote: params.quote,
      config: this.adapter.configStatus(),
    });
    this.state.markFromPayload("allocation", payload);
    return payload;
  }

  async getOpenFuturesPositions() {
    const payload = await this.services.openFuturesPositions.snapshot();
    this.state.markFromPayload("openFuturesPositions", payload);
    return payload;
  }

  async getTopAssets(params = {}) {
    const payload = await this.services.topAssets.snapshot(params);
    this.state.markFromPayload("topAssets", payload);
    return payload;
  }

  subscribeOpenFuturesPositions(response) {
    return this.services.openFuturesPositions.subscribe(response);
  }

  subscribeOpenFuturesPositionsLegacy(response) {
    return this.adapter.subscribeOpenFuturesPositions(response);
  }

  async getTradeRecords(params = {}) {
    const payload = await this.services.tradeRecords.snapshot(params);
    this.state.markFromPayload("tradeRecords", payload);
    return payload;
  }

  getTradeRecordsFeeSummary(params = {}) {
    return this.services.tradeRecords.feeSummary(params);
  }

  subscribeTradeRecords(response, query = {}) {
    return this.services.tradeRecords.subscribe(response, query);
  }

  subscribeTradeRecordsLegacy(response, query = {}) {
    return this.adapter.subscribeTradeRecords(response, query);
  }

  async getMarketCandles(params = {}) {
    const payload = await this.services.marketCandles.snapshot(params);
    this.state.markFromPayload("marketCandles", payload);
    return payload;
  }

  subscribeMarketCandles(response, params = {}) {
    return this.services.marketCandles.subscribe(response, params);
  }

  subscribeMarketCandlesLegacy(response, params = {}) {
    return this.adapter.subscribeMarketCandles({
      response,
      ...params,
    });
  }

  async getTradingPairDetail(params = {}) {
    const payload = await this.services.tradingPairDetail.snapshot(params);
    this.state.markFromPayload("tradingPairDetail", payload);
    return payload;
  }

  async getBtcSummary(params = {}) {
    const payload = await this.services.btcSummary.snapshot(params);
    this.state.markFromPayload("btcSummary", payload);
    return payload;
  }

  publish(topic, payload) {
    return this.sseHub.publish(topic, payload);
  }
}

const cryptoDataHub = new CryptoDataHub();

module.exports = {
  CryptoDataHub,
  cryptoDataHub,
};
