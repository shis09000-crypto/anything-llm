const {
  GateBtcSpotSummaryService,
  GateOpenFuturesPositionsService,
  GateRestClient,
  GateTopSpotAssetsService,
  GateTradeRecordsFeeSummaryService,
  GateTradeRecordsService,
  GateTradingPairDetailService,
} = require("../cryptoGate");
const {
  AllocationHubService,
} = require("../cryptoHub/services/allocationHubService");
const { CryptoHubCache } = require("../cryptoHub/cache/CryptoHubCache");
const { metrics } = require("../observability/metrics");
const {
  CryptoHubRateLimitState,
} = require("../cryptoHub/cache/CryptoHubRateLimitState");
const { AccountEquityProtectionService } = require("./equityProtection");
const {
  SupplementalPortfolioService,
  computePortfolioRisk,
  mergePortfolio,
  mergeSpotDetail,
  simulateRebalance,
} = require("./portfolioSnapshot");

const PRIVATE_CACHE_TTL_MS = 15_000;

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalizeSymbol(value = null) {
  const symbol = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[-/]/g, "_");
  return symbol || null;
}

function accountToolAllocationItem(item = {}) {
  return {
    symbol: item.symbol,
    percentageOfCombinedHoldings: item.percentage,
    totalAmount: item.totalAmount,
    spotAmount: item.spotAmount,
    earnAmount: item.earnAmount,
    totalValueUsd: item.valueUsd,
    spotValueUsd: item.spotValueUsd,
    earnValueUsd: item.earnValueUsd,
    holdingSources: item.holdingSources,
    priceUsd: item.priceUsd,
    change24hPct: item.change24hPct,
  };
}

function accountToolPositionItem(position = {}) {
  return {
    symbol: position.symbol,
    side: position.side,
    marginMode: position.marginMode,
    contractSize: position.contractSize,
    contractSizeUnit: position.contractSizeUnit,
    baseEquivalentAmount: position.baseEquivalentAmount,
    baseEquivalentSemantics: position.quantitySemantics,
    notionalUsd: position.notionalUsd,
    entryPrice: position.entryPrice,
    markPrice: position.markPrice,
    configuredLeverage: position.configuredLeverage,
    effectiveLeverage: position.effectiveLeverage,
    leverageScope: position.leverageScope,
    initialMarginUsd: position.initialMarginUsd,
    maintenanceMarginUsd: position.maintenanceMarginUsd,
    marginSemantics: position.marginSemantics,
    unrealizedPnlUsd: position.unrealizedPnlUsd,
    pnlPct: position.pnlPct,
    pnlPctUnavailableReason: position.pnlPctUnavailableReason,
    liquidationPrice: position.liquidationPrice,
    liquidationPriceReferenceOnly: position.liquidationPriceReferenceOnly,
    liquidationDistancePct: position.liquidationDistancePct,
    riskAssessment: position.riskAssessment,
  };
}

function accountToolPositionSummary(summary = {}) {
  return {
    marginMode: summary.marginMode,
    totalUnrealizedPnlUsd: summary.totalUnrealizedPnlUsd,
    totalNotionalUsd: summary.totalNotionalUsd,
    accountInitialMarginUsd: summary.accountInitialMarginUsd,
    accountMaintenanceMarginUsd: summary.accountMaintenanceMarginUsd,
    accountOrderMarginUsd: summary.accountOrderMarginUsd,
    crossAvailableUsd: summary.crossAvailableUsd,
    initialMarginToCrossAvailablePct: summary.initialMarginToCrossAvailablePct,
    weightedPnlPct: summary.weightedPnlPct,
    weightedPnlPctUnavailableReason: summary.weightedPnlPctUnavailableReason,
    riskAssessment: summary.riskAssessment,
  };
}

class InMemoryCycleStore {
  constructor() {
    this.cycles = [];
  }

  async load() {
    return this.cycles;
  }

  async saveCompleteCycles(cycles = []) {
    const byId = new Map(this.cycles.map((cycle) => [cycle.cycleId, cycle]));
    for (const cycle of cycles) {
      if (cycle?.cycleId) byId.set(cycle.cycleId, cycle);
    }
    this.cycles = Array.from(byId.values()).slice(-500);
    return this.cycles;
  }
}

class AccountCryptoHub {
  constructor({ connection, credentials, equityProtection = null }) {
    this.connectionId = connection.id;
    this.authUserId = connection.authUserId;
    this.credentialVersion = connection.credentialVersion;
    this.credentials = Object.freeze({ ...credentials });
    this.cache = new CryptoHubCache();
    this.rateLimitState = new CryptoHubRateLimitState();
    this.clientFactory = () => new GateRestClient(this.credentials);
    this.allocation = new AllocationHubService({
      restClientFactory: this.clientFactory,
    });
    this.positions = new GateOpenFuturesPositionsService({
      restClientFactory: this.clientFactory,
      wsManager: {
        status: () => ({
          spot: { status: "idle" },
          futuresUsdt: { status: "idle" },
        }),
      },
    });
    this.topAssets = new GateTopSpotAssetsService({
      restClientFactory: this.clientFactory,
    });
    this.tradingPairDetails = new GateTradingPairDetailService({
      restClientFactory: this.clientFactory,
    });
    this.btcSummary = new GateBtcSpotSummaryService({
      restClientFactory: this.clientFactory,
    });
    this.tradeRecords = new GateTradeRecordsService({
      restClientFactory: this.clientFactory,
      wsManager: {
        status: () => ({
          spot: { status: "idle" },
          futuresUsdt: { status: "idle" },
        }),
      },
      cycleMemoryStore: new InMemoryCycleStore(),
    });
    this.feeSummary = new GateTradeRecordsFeeSummaryService({
      restClientFactory: this.clientFactory,
    });
    this.equityProtection =
      equityProtection ||
      new AccountEquityProtectionService({
        connection,
        restClientFactory: this.clientFactory,
      });
    this.supplementalPortfolio = new SupplementalPortfolioService({
      connection,
    });
    this.dashboardCache = null;
    this.dashboardInFlight = null;
  }

  async cached(key, loader) {
    const cached = this.cache.get(key);
    if (cached) return cached;
    const value = await loader();
    return this.cache.set(key, value, { ttlMs: PRIVATE_CACHE_TTL_MS });
  }

  async overview() {
    return this.cached("overview", async () => {
      const client = this.clientFactory();
      const [balance, allocation, positions] = await Promise.all([
        client.getTotalBalanceRaw(),
        this.allocation.snapshot({ quote: "USDT" }),
        this.positions.snapshot(),
      ]);
      if (!balance?.success) {
        throw new Error(
          balance?.safeErrorMessage || "Gate total balance request failed."
        );
      }
      this.rateLimitState.update("private", balance.rateLimit);
      const total =
        balance.data?.total?.amount ??
        balance.data?.total ??
        allocation.totalValueUsd ??
        "0";
      return {
        success: true,
        asOf: Date.now(),
        exchange: "gate",
        environment: this.credentials.env,
        readOnly: true,
        totalEquityUsd: String(total),
        allocation: {
          holdingScope: allocation.holdingScope,
          totalValueUsd: allocation.totalValueUsd,
          combinedValueUsd: allocation.combinedValueUsd,
          spotValueUsd: allocation.spotValueUsd,
          earnValueUsd: allocation.earnValueUsd,
          items: allocation.items.slice(0, 6),
        },
        positions: {
          count: positions.positions.length,
          summary: positions.summary,
          items: positions.positions.slice(0, 6),
        },
        reportingGuidance: {
          holdings:
            "Allocation totalAmount/amount combines spotAmount and earnAmount. Report spot and earn separately; never label the combined quantity as spot holdings.",
          futures:
            "For cross-margin positions, configuredLeverage is not effective account leverage, per-position pnlPct is unavailable, position initial margins are not additive, and liquidation prices are reference-only. Use the account-level Gate margin fields and do not infer liquidation safety.",
        },
        connectionStatus:
          allocation.connectionStatus === "connected" &&
          positions.connectionStatus === "connected"
            ? "connected"
            : "degraded",
      };
    });
  }

  async toolOverview() {
    const overview = await this.overview();
    return {
      ...overview,
      allocation: {
        holdingScope: overview.allocation.holdingScope,
        combinedValueUsd: overview.allocation.combinedValueUsd,
        spotValueUsd: overview.allocation.spotValueUsd,
        earnValueUsd: overview.allocation.earnValueUsd,
        items: overview.allocation.items.map(accountToolAllocationItem),
      },
      positions: {
        count: overview.positions.count,
        summary: accountToolPositionSummary(overview.positions.summary),
        items: overview.positions.items.map(accountToolPositionItem),
      },
    };
  }

  async privateSnapshot() {
    return this.clientFactory().snapshot();
  }

  recentEvents() {
    return [];
  }

  getStatus() {
    return {
      enabled: true,
      readOnly: true,
      gate: {
        configured: true,
        privateRest: "connected",
        privateWs: "disconnected",
        publicRest: "connected",
        publicWs: "disconnected",
      },
      services: {
        equity: this.equityProtection.status().running
          ? "protected"
          : "initializing",
        allocation: "ready",
        openFuturesPositions: "ready",
        topAssets: "ready",
        tradingPairDetail: "ready",
        tradeRecords: "ready",
      },
      rateLimits: this.rateLimitState.snapshot(),
      accountScoped: true,
      equityProtection: this.equityProtection.status(),
    };
  }

  getLoadingProgress() {
    return {
      status: "ready",
      accountScoped: true,
      items: {
        privateAccount: { status: "ready" },
        allocation: { status: "ready" },
        tradingPairDetail: { status: "ready" },
        openFutures: { status: "ready" },
        tradeRecords: { status: "ready" },
      },
    };
  }

  async init() {
    this.start();
    return {
      success: true,
      status: this.getStatus(),
      loadingProgress: this.getLoadingProgress(),
    };
  }

  start() {
    void this.equityProtection.start().catch(() => {});
    return this.getStatus();
  }

  stopIfIdle() {
    return {
      success: true,
      stoppedPrivateWs: true,
      reason: "Account-scoped HTTP hub has no shared private WebSocket.",
    };
  }

  stopBackgroundRefresh() {
    return {
      success: true,
      stoppedPrivateWs: true,
      protectedEquityRecorderRunning: this.equityProtection.status().running,
      reason:
        "Private streams may stop when idle; protected equity recording remains active.",
    };
  }

  async getEquityHistory(params = {}) {
    return this.equityProtection.history(params);
  }

  getAllocation(params = {}) {
    return this.holdings({ limit: 20, ...params });
  }

  getOpenFuturesPositions(params = {}) {
    return this.openPositions(params);
  }

  getTopAssets(params = {}) {
    return this.topAssets.topAssets(params);
  }

  getTradingPairDetail(params = {}) {
    return this.tradingPairDetails.detail(params);
  }

  getBtcSummary(params = {}) {
    return this.btcSummary.summary(params);
  }

  getTradeRecords(params = {}) {
    return this.activity({
      days: params.days || 30,
      limit: params.limit || 50,
      cursor: params.cursorTs || null,
      symbol: params.symbol || null,
    });
  }

  getTradeRecordsFeeSummary(params = {}) {
    return this.feeSummary.snapshot(params);
  }

  async buildDashboardSnapshot() {
    const [equityHistory, allocation, positions, supplementalHoldings] =
      await Promise.all([
        this.equityProtection.history({ window: "today" }),
        this.holdings({ limit: 20 }),
        this.openPositions({ limit: 50 }),
        this.supplementalPortfolio.activeHoldings(),
      ]);
    const history = equityHistory?.history || {};
    const priceBySymbol = Object.fromEntries(
      (allocation.items || []).map((item) => [item.symbol, item.priceUsd])
    );
    for (const [symbol, reference] of Object.entries(
      allocation.referencePrices || {}
    )) {
      if (reference?.priceUsd) priceBySymbol[symbol] = reference.priceUsd;
    }
    const gateTotalUsd =
      history.latestEquityUsd ?? allocation.totalValueUsd ?? 0;
    const portfolio = mergePortfolio({
      gateTotalUsd,
      gateAllocation: allocation,
      supplementalHoldings,
      priceBySymbol,
      asOf: Math.max(
        Number(history.latestPointTs || 0),
        Number(allocation.asOf || 0),
        Number(positions.asOf || 0)
      ),
    });
    const detailFor = (symbol) => {
      const gateItem = (allocation.items || []).find(
        (item) => item.symbol === symbol
      );
      const reference = allocation.referencePrices?.[symbol] || null;
      return mergeSpotDetail({
        detail: {
          success: true,
          asOf: allocation.asOf,
          exchange: "gate",
          baseAsset: symbol,
          quoteAsset: "USDT",
          gateCurrencyPair: `${symbol}_USDT`,
          symbol: `${symbol}/USDT`,
          marketType: "spot",
          connectionStatus: allocation.connectionStatus,
          holdingAmountBase: gateItem?.totalAmount || "0",
          holdingValueQuote: gateItem?.valueUsd || "0.00",
          holdingValueUsd: gateItem?.valueUsd || "0.00",
          currentPriceQuote: gateItem?.priceUsd || reference?.priceUsd || null,
          change24hPct:
            gateItem?.change24hPct || reference?.change24hPct || null,
          averageBuyPriceQuote: null,
          averageBuyPriceMethod: "calculating",
          averageBuyPriceScope: "calculating",
          holdingSources: {
            spot: gateItem?.spotAmount || "0",
            earnUni: gateItem?.earnAmount || "0",
            selected: "combined",
          },
          freshness: {
            latestSnapshotAt: allocation.asOf,
            lastRefreshSource: "dashboard-snapshot",
          },
          partialFailures: allocation.partialFailures || [],
        },
        portfolio,
        symbol,
      });
    };
    const connectionStatus = [
      allocation.connectionStatus,
      positions.connectionStatus,
      history.connectionStatus,
      portfolio.connectionStatus,
    ].includes("disconnected")
      ? "disconnected"
      : [
            allocation.connectionStatus,
            positions.connectionStatus,
            history.connectionStatus,
            portfolio.connectionStatus,
          ].includes("degraded")
        ? "degraded"
        : "connected";
    const risk = computePortfolioRisk({
      portfolio,
      positions,
      equityHistory,
      connectionStatus,
    });
    return {
      success: true,
      asOf: Date.now(),
      readOnly: true,
      accountScoped: true,
      connectionStatus,
      portfolio,
      risk,
      equityHistory: history,
      spotDetails: {
        BTC: detailFor("BTC"),
        ETH: detailFor("ETH"),
      },
      futures: {
        summary: positions.summary,
        positions: positions.positions,
        partialFailures: positions.partialFailures || [],
      },
      sourcePolicy: {
        gate: "authoritative_real_account",
        supplemental: "user_supplied_current_portfolio_only",
        supplementalIncludedInPnl: false,
        supplementalIncludedInHistory: false,
      },
    };
  }

  async dashboardSnapshot({ force = false } = {}) {
    const startedAt = Date.now();
    const recordRead = (outcome) => {
      metrics.cryptoAccountReads.inc({
        function: "dashboard_snapshot",
        outcome,
      });
      metrics.cryptoAccountReadDuration.observe(
        { function: "dashboard_snapshot", outcome },
        Math.max(0, Date.now() - startedAt) / 1_000
      );
    };
    const now = Date.now();
    const ageMs = this.dashboardCache
      ? now - this.dashboardCache.updatedAt
      : Infinity;
    if (!force && this.dashboardCache && ageMs <= 5_000) {
      recordRead("cache_fresh");
      return {
        ...this.dashboardCache.value,
        cache: { status: "fresh", ageMs },
      };
    }
    if (!force && this.dashboardCache && ageMs <= 60_000) {
      if (!this.dashboardInFlight) {
        this.dashboardInFlight = this.buildDashboardSnapshot()
          .then((value) => {
            this.dashboardCache = { value, updatedAt: Date.now() };
            return value;
          })
          .finally(() => {
            this.dashboardInFlight = null;
          });
        void this.dashboardInFlight.catch(() => {});
      }
      recordRead("cache_stale_revalidate");
      return {
        ...this.dashboardCache.value,
        cache: { status: "stale_revalidate", ageMs },
      };
    }
    if (!this.dashboardInFlight) {
      this.dashboardInFlight = this.buildDashboardSnapshot()
        .then((value) => {
          this.dashboardCache = { value, updatedAt: Date.now() };
          return value;
        })
        .finally(() => {
          this.dashboardInFlight = null;
        });
    }
    try {
      const value = await this.dashboardInFlight;
      recordRead("refreshed");
      return { ...value, cache: { status: "refreshed", ageMs: 0 } };
    } catch (error) {
      recordRead("failed");
      throw error;
    }
  }

  subscribeDashboard(response) {
    return this.subscribePolling(
      response,
      () => this.dashboardSnapshot(),
      "snapshot"
    );
  }

  async toolPortfolioOverview() {
    const snapshot = await this.dashboardSnapshot();
    return {
      success: true,
      asOf: snapshot.asOf,
      readOnly: true,
      connectionStatus: snapshot.connectionStatus,
      portfolio: snapshot.portfolio,
      sourcePolicy: snapshot.sourcePolicy,
    };
  }

  async toolPortfolioRisk() {
    const snapshot = await this.dashboardSnapshot();
    return {
      success: true,
      asOf: snapshot.asOf,
      readOnly: true,
      connectionStatus: snapshot.connectionStatus,
      risk: snapshot.risk,
      sourcePolicy: snapshot.sourcePolicy,
    };
  }

  async rebalanceSimulation(targets = {}) {
    const snapshot = await this.dashboardSnapshot();
    return simulateRebalance({ portfolio: snapshot.portfolio, targets });
  }

  async portfolioPerformance({ window = "30d" } = {}) {
    const daysByWindow = { "7d": 7, "30d": 30, "90d": 90, "365d": 365 };
    const days = daysByWindow[window];
    if (!days) {
      const error = new Error("crypto_equity_window_invalid");
      error.code = "crypto_equity_window_invalid";
      throw error;
    }
    const nowSec = Math.floor(Date.now() / 1_000);
    const fromSec = nowSec - days * 24 * 60 * 60;
    const tradeFromSec = nowSec - Math.min(days, 90) * 24 * 60 * 60;
    const [historyResult, records, positions, fees] = await Promise.all([
      this.equityProtection.history({ window }),
      this.tradeRecords.snapshot({
        from: tradeFromSec,
        to: nowSec,
        limit: 100,
      }),
      this.openPositions({ limit: 50 }),
      this.feeSummary.snapshot({
        from: fromSec,
        to: nowSec,
        includeYear: false,
      }),
    ]);
    const history = historyResult.history || {};
    const realizedPnlUsd = Number(records.summary?.totalRealizedPnlUsd || 0);
    const unrealizedPnlUsd = Number(
      positions.summary?.totalUnrealizedPnlUsd || 0
    );
    const feeUsd = Number(fees.totalFeeUsd || 0);
    const totalChangeUsd = Number(history.changeUsd || 0);
    return {
      success: true,
      readOnly: true,
      asOf: Date.now(),
      window,
      history,
      attribution: {
        totalGateEquityChangeUsd: Number(totalChangeUsd.toFixed(2)),
        futuresRealizedPnlUsd: Number(realizedPnlUsd.toFixed(2)),
        futuresUnrealizedPnlUsd: Number(unrealizedPnlUsd.toFixed(2)),
        feesUsd: Number(feeUsd.toFixed(2)),
        fundingUsd: null,
        spotPriceEffectUsd: null,
        unclassifiedCapitalFlowUsd: null,
        status: "partial",
        guidance:
          "Gate equity history is authoritative. Funding, spot-price attribution, deposits, withdrawals, and transfers remain unclassified until exchange evidence is available and are not reported as investment return.",
      },
      coverage: {
        tradeHistoryDays: Math.min(days, 90),
        requestedDays: days,
        tradeRecordLimit: 100,
        supplementalIncluded: false,
      },
      sourcePolicy: {
        gate: "authoritative_real_account",
        supplementalIncludedInHistory: false,
        modelGenerated: false,
      },
    };
  }

  subscribePolling(response, loader, event = "snapshot") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders?.();
    let stopped = false;
    let writing = false;
    const write = async () => {
      if (stopped || writing || response.destroyed || response.writableEnded)
        return;
      writing = true;
      try {
        const payload = await loader();
        response.write(`event: ${event}\n`);
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch (error) {
        response.write("event: error\n");
        response.write(
          `data: ${JSON.stringify({
            success: false,
            safeErrorMessage: String(
              error?.code || "crypto_account_stream_failed"
            ),
          })}\n\n`
        );
      } finally {
        writing = false;
      }
    };
    const timer = setInterval(write, 5_000);
    timer.unref?.();
    write();
    const stop = () => {
      stopped = true;
      clearInterval(timer);
    };
    response.on("close", stop);
    response.on("error", stop);
    return stop;
  }

  subscribeOpenFuturesPositions(response) {
    return this.subscribePolling(response, () => this.openPositions());
  }

  subscribeOpenFuturesPositionsLegacy(response) {
    return this.subscribeOpenFuturesPositions(response);
  }

  subscribeTradeRecords(response, query = {}) {
    return this.subscribePolling(response, () => this.getTradeRecords(query));
  }

  subscribeTradeRecordsLegacy(response, query = {}) {
    return this.subscribeTradeRecords(response, query);
  }

  async holdings({ symbol = null, limit = 10 } = {}) {
    const normalized = normalizeSymbol(symbol);
    const bounded = boundedInteger(limit, 10, 1, 20);
    const cacheKey = `holdings:${normalized || "all"}:${bounded}`;
    return this.cached(cacheKey, async () => {
      const snapshot = await this.allocation.snapshot({ quote: "USDT" });
      const items = normalized
        ? snapshot.items.filter(
            (item) => normalizeSymbol(item.symbol) === normalized
          )
        : snapshot.items;
      return {
        ...snapshot,
        requestedSymbol: normalized,
        limit: bounded,
        reportingGuidance:
          "Each item exposes spotAmount, earnAmount, and totalAmount. Report the sources separately; totalAmount is spot plus earn and must not be described as spot-only.",
        items: items.slice(0, bounded),
      };
    });
  }

  async openPositions({ symbol = null, limit = 50 } = {}) {
    const normalized = normalizeSymbol(symbol)?.replace(/_/g, "");
    const bounded = boundedInteger(limit, 50, 1, 50);
    const cacheKey = `positions:${normalized || "all"}:${bounded}`;
    return this.cached(cacheKey, async () => {
      const snapshot = await this.positions.snapshot();
      const positions = normalized
        ? snapshot.positions.filter(
            (position) =>
              normalizeSymbol(position.symbol)?.replace(/_/g, "") === normalized
          )
        : snapshot.positions;
      return {
        ...snapshot,
        requestedSymbol: normalized,
        limit: bounded,
        reportingGuidance:
          "For cross-margin positions, configuredLeverage is a position configuration value, not effective portfolio leverage. Per-position pnlPct is intentionally unavailable, Gate account initial/maintenance margin fields are authoritative, and liquidation prices are reference-only.",
        positions: positions.slice(0, bounded),
      };
    });
  }

  async toolOpenPositions(params = {}) {
    const snapshot = await this.openPositions(params);
    return {
      success: snapshot.success,
      asOf: snapshot.asOf,
      exchange: snapshot.exchange,
      marketType: snapshot.marketType,
      settle: snapshot.settle,
      requestedSymbol: snapshot.requestedSymbol,
      limit: snapshot.limit,
      connectionStatus: snapshot.connectionStatus,
      partialFailures: snapshot.partialFailures,
      summary: accountToolPositionSummary(snapshot.summary),
      positions: snapshot.positions.map(accountToolPositionItem),
      reportingGuidance: snapshot.reportingGuidance,
    };
  }

  async activity({ days = 7, limit = 50, cursor = null, symbol = null } = {}) {
    const boundedDays = boundedInteger(days, 7, 1, 90);
    const boundedLimit = boundedInteger(limit, 50, 1, 100);
    const nowSec = Math.floor(Date.now() / 1_000);
    const from = nowSec - boundedDays * 24 * 60 * 60;
    const cursorTs = cursor ? Number(cursor) : null;
    const normalized = normalizeSymbol(symbol)?.replace(/_/g, "");
    const records = await this.tradeRecords.snapshot({
      from,
      to: nowSec,
      cursorTs,
      limit: boundedLimit,
    });
    const filtered = normalized
      ? records.records.filter(
          (record) =>
            normalizeSymbol(record.symbol)?.replace(/_/g, "") === normalized
        )
      : records.records;
    const fees = await this.feeSummary.snapshot({
      from,
      to: nowSec,
      includeYear: false,
    });
    return {
      ...records,
      days: boundedDays,
      requestedSymbol: normalized,
      limit: boundedLimit,
      records: filtered.slice(0, boundedLimit),
      feeSummary: {
        totalFeeUsd: fees.totalFeeUsd,
        feeSources: fees.feeSources,
      },
    };
  }

  clear() {
    void this.equityProtection.stop();
    this.cache.clear();
    this.dashboardCache = null;
    this.dashboardInFlight = null;
    this.credentials = Object.freeze({
      apiKey: "",
      apiSecret: "",
      env: this.credentials.env,
    });
  }
}

class AccountCryptoHubRegistry {
  constructor({ equityProtectionFactory = null } = {}) {
    this.hubs = new Map();
    this.equityProtectionFactory = equityProtectionFactory;
  }

  key(connection) {
    return `${connection.authUserId}:${connection.id}`;
  }

  get({ connection, credentials }) {
    const key = this.key(connection);
    const existing = this.hubs.get(key);
    if (
      existing &&
      Number(existing.credentialVersion) ===
        Number(connection.credentialVersion)
    ) {
      return existing;
    }
    if (existing) existing.clear();
    const hub = new AccountCryptoHub({
      connection,
      credentials,
      equityProtection: this.equityProtectionFactory?.({
        connection,
        credentials,
      }),
    });
    this.hubs.set(key, hub);
    return hub;
  }

  getExisting({ authUserId, connectionId, credentialVersion }) {
    if (!connectionId) return null;
    const existing = this.hubs.get(
      `${Number(authUserId)}:${String(connectionId)}`
    );
    if (!existing) return null;
    if (Number(existing.credentialVersion) !== Number(credentialVersion)) {
      return null;
    }
    return existing;
  }

  invalidateConnection(connectionId) {
    for (const [key, hub] of this.hubs.entries()) {
      if (hub.connectionId !== String(connectionId)) continue;
      hub.clear();
      this.hubs.delete(key);
    }
  }

  invalidateOwner(authUserId) {
    for (const [key, hub] of this.hubs.entries()) {
      if (Number(hub.authUserId) !== Number(authUserId)) continue;
      hub.clear();
      this.hubs.delete(key);
    }
  }

  size() {
    return this.hubs.size;
  }

  protectedCount() {
    return [...this.hubs.values()].filter(
      (hub) => hub.equityProtection.status().running
    ).length;
  }

  async stopProtectedRecorders() {
    await Promise.allSettled(
      [...this.hubs.values()].map((hub) => hub.equityProtection.stop())
    );
  }

  clear() {
    for (const hub of this.hubs.values()) hub.clear();
    this.hubs.clear();
  }
}

const accountCryptoHubRegistry = new AccountCryptoHubRegistry();

module.exports = {
  AccountCryptoHub,
  AccountCryptoHubRegistry,
  accountCryptoHubRegistry,
};
