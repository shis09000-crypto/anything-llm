const {
  addDecimalStrings,
  divideRounded,
  formatScaledInt,
  multiplyDecimalStrings,
  toScaledInt,
  trimDecimal,
} = require("./decimal");
const { GateRestClient } = require("./restClient");
const { safeErrorMessage } = require("./sanitizer");

const BTC_SYMBOL = "BTC";
const BTC_SPOT_PAIR = "BTC_USDT";
const NORMAL_INTERVALS = {
  market: 5_000,
  balance: 10_000,
  averageBuy: 5 * 60_000,
};
const SLOW_INTERVALS = {
  market: 15_000,
  balance: 30_000,
  averageBuy: 10 * 60_000,
};
const RATE_LIMIT_SLOW_THRESHOLD_PCT = 20;
const TRADE_PAGE_LIMIT = 1000;
const TRADE_WINDOW_DAYS = 30;
const DEFAULT_COST_LOOKBACK_DAYS = 365;
const MAX_TRADE_PAGES_PER_WINDOW = 100;
const AMOUNT_SCALE = 12;
const PRICE_SCALE = 8;
const COST_SCALE = AMOUNT_SCALE + PRICE_SCALE;
const BTC_TOLERANCE_SCALED = toScaledInt("0.000001", AMOUNT_SCALE);

function nowMs() {
  return Date.now();
}

function positiveString(value, fallback = "0") {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? String(value) : fallback;
}

function normalizeTicker(data) {
  const ticker = Array.isArray(data) ? data[0] : data;
  if (!ticker || typeof ticker !== "object") {
    throw new Error("Gate BTC ticker response was empty.");
  }

  const last = positiveString(ticker.last || ticker.close, null);
  if (!last) throw new Error("Gate BTC ticker last price was not found.");

  const change24hPct =
    ticker.change_percentage ??
    ticker.change_utc0 ??
    ticker.change_utc8 ??
    ticker.change;
  const changePct = Number(change24hPct);
  const change24hUsd = Number.isFinite(changePct)
    ? ((Number(last) * changePct) / (100 + changePct)).toFixed(2)
    : null;

  return {
    currentPriceUsd: String(last),
    change24hPct:
      change24hPct === undefined || change24hPct === null
        ? null
        : String(change24hPct),
    change24hUsd,
  };
}

function normalizeCandle(candle) {
  if (Array.isArray(candle)) {
    const ts = Number(candle[0]) * 1_000;
    return {
      ts,
      volume: String(candle[1] ?? "0"),
      close: String(candle[2] ?? "0"),
      high: String(candle[3] ?? candle[2] ?? "0"),
      low: String(candle[4] ?? candle[2] ?? "0"),
      open: String(candle[5] ?? candle[2] ?? "0"),
    };
  }

  if (candle && typeof candle === "object") {
    const rawTs =
      candle.t || candle.time || candle.timestamp || candle.create_time || 0;
    const numericTs = Number(rawTs);
    return {
      ts: numericTs > 10_000_000_000 ? numericTs : numericTs * 1_000,
      open: String(candle.o ?? candle.open ?? candle.close ?? candle.c ?? "0"),
      high: String(candle.h ?? candle.high ?? candle.close ?? candle.c ?? "0"),
      low: String(candle.l ?? candle.low ?? candle.close ?? candle.c ?? "0"),
      close: String(candle.c ?? candle.close ?? "0"),
      volume: String(candle.v ?? candle.volume ?? "0"),
    };
  }

  return null;
}

function normalizeCandles(data) {
  if (!Array.isArray(data)) return [];
  return data
    .map(normalizeCandle)
    .filter(
      (candle) =>
        candle &&
        Number.isFinite(candle.ts) &&
        Number(candle.open) > 0 &&
        Number(candle.high) > 0 &&
        Number(candle.low) > 0 &&
        Number(candle.close) > 0
    )
    .sort((left, right) => left.ts - right.ts);
}

function normalizeBtcBalance(data) {
  if (!Array.isArray(data)) {
    throw new Error("Gate spot accounts response was empty.");
  }

  const btcAccount = data.find(
    (account) => String(account?.currency || "").toUpperCase() === BTC_SYMBOL
  );
  if (!btcAccount) return "0";

  return addDecimalStrings(
    [btcAccount.available || "0", btcAccount.locked || "0"],
    {
      scale: 12,
      decimals: 8,
    }
  );
}

function configuredCostLookbackDays() {
  const value = Number(process.env.GATE_BTC_COST_LOOKBACK_DAYS);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_COST_LOOKBACK_DAYS;
  return Math.max(30, Math.min(3650, Math.round(value)));
}

function tradeTimestamp(trade) {
  const raw =
    trade?.create_time_ms ??
    trade?.time_ms ??
    trade?.create_time ??
    trade?.time ??
    0;
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0;
  return value > 10_000_000_000 ? value : value * 1_000;
}

function tradeAmountScaled(trade) {
  return toScaledInt(
    trade?.amount || trade?.size || trade?.quantity || "0",
    AMOUNT_SCALE
  );
}

function tradePriceScaled(trade) {
  return toScaledInt(trade?.price || "0", PRICE_SCALE);
}

function tradeFeeScaled(trade, currency, scale) {
  if (String(trade?.fee_currency || "").toUpperCase() !== currency) return 0n;
  return toScaledInt(trade?.fee || "0", scale);
}

function absBigInt(value) {
  return value < 0n ? -value : value;
}

function averagePriceFromCost({ costScaled, amountScaled, decimals = 2 }) {
  if (amountScaled <= 0n || costScaled <= 0n) return null;
  const precisionDelta = COST_SCALE - AMOUNT_SCALE - decimals;
  const scaled =
    precisionDelta >= 0
      ? divideRounded(costScaled, amountScaled * 10n ** BigInt(precisionDelta))
      : divideRounded(
          costScaled * 10n ** BigInt(-precisionDelta),
          amountScaled
        );
  return formatScaledInt(scaled, decimals, decimals);
}

function applySellToLots(lots, sellAmountScaled) {
  let remainingToSell = sellAmountScaled;

  while (remainingToSell > 0n && lots.length) {
    const lot = lots[0];
    if (lot.amountScaled <= remainingToSell) {
      remainingToSell -= lot.amountScaled;
      lots.shift();
      continue;
    }

    const costReduction = divideRounded(
      lot.costScaled * remainingToSell,
      lot.amountScaled
    );
    lot.amountScaled -= remainingToSell;
    lot.costScaled -= costReduction;
    remainingToSell = 0n;
  }

  return remainingToSell;
}

function remainingCostFromTrades(trades = [], currentBtcAmount = "0") {
  const currentAmountScaled = toScaledInt(currentBtcAmount, AMOUNT_SCALE);
  if (currentAmountScaled <= 0n) {
    return {
      averageBuyPriceUsd: null,
      averageBuyPriceScope: "unknown",
      averageBuyPriceMethod: "fifo_remaining_cost",
      averageBuyTradeCount: 0,
      averageBuyHistoryComplete: false,
    };
  }

  const lots = [];
  let buyTradeCount = 0;
  let unmatchedSellAmountScaled = 0n;

  const sortedTrades = [...trades]
    .filter((trade) => tradeTimestamp(trade) > 0)
    .sort((left, right) => tradeTimestamp(left) - tradeTimestamp(right));

  for (const trade of sortedTrades) {
    const side = String(trade?.side || "").toLowerCase();
    const amountScaled = tradeAmountScaled(trade);
    const priceScaled = tradePriceScaled(trade);
    if (amountScaled <= 0n || priceScaled <= 0n) continue;

    if (side === "buy") {
      const baseFeeScaled = tradeFeeScaled(trade, BTC_SYMBOL, AMOUNT_SCALE);
      const quoteFeeScaled = tradeFeeScaled(trade, "USDT", COST_SCALE);
      const receivedAmountScaled = amountScaled - baseFeeScaled;
      if (receivedAmountScaled <= 0n) continue;
      lots.push({
        amountScaled: receivedAmountScaled,
        costScaled: amountScaled * priceScaled + quoteFeeScaled,
      });
      buyTradeCount += 1;
    }

    if (side === "sell") {
      unmatchedSellAmountScaled += applySellToLots(lots, amountScaled);
    }
  }

  const reconstructedAmountScaled = lots.reduce(
    (sum, lot) => sum + lot.amountScaled,
    0n
  );
  const diffScaled = reconstructedAmountScaled - currentAmountScaled;
  const historyMatchesBalance =
    absBigInt(diffScaled) <= BTC_TOLERANCE_SCALED &&
    unmatchedSellAmountScaled === 0n;

  if (!historyMatchesBalance || reconstructedAmountScaled <= 0n) {
    return {
      averageBuyPriceUsd: null,
      averageBuyPriceScope: "insufficient_history",
      averageBuyPriceMethod: "fifo_remaining_cost",
      averageBuyTradeCount: buyTradeCount,
      averageBuyHistoryComplete: false,
      reconstructedBtcAmount: trimDecimal(
        formatScaledInt(reconstructedAmountScaled, AMOUNT_SCALE, 8)
      ),
    };
  }

  const remainingCostScaled = lots.reduce(
    (sum, lot) => sum + lot.costScaled,
    0n
  );
  return {
    averageBuyPriceUsd: averagePriceFromCost({
      costScaled: remainingCostScaled,
      amountScaled: reconstructedAmountScaled,
      decimals: 2,
    }),
    averageBuyPriceScope: "full",
    averageBuyPriceMethod: "fifo_remaining_cost",
    averageBuyTradeCount: buyTradeCount,
    averageBuyHistoryComplete: true,
    reconstructedBtcAmount: trimDecimal(
      formatScaledInt(reconstructedAmountScaled, AMOUNT_SCALE, 8)
    ),
  };
}

class GateBtcSpotSummaryService {
  constructor({ restClientFactory = () => new GateRestClient() } = {}) {
    this.restClientFactory = restClientFactory;
    this.marketCache = null;
    this.balanceCache = null;
    this.averageBuyCache = null;
    this.marketInFlight = null;
    this.balanceInFlight = null;
    this.averageBuyInFlight = null;
    this.rateLimitRemainPct = null;
  }

  intervalFor(kind) {
    const intervals =
      this.rateLimitRemainPct !== null &&
      this.rateLimitRemainPct < RATE_LIMIT_SLOW_THRESHOLD_PCT
        ? SLOW_INTERVALS
        : NORMAL_INTERVALS;
    return intervals[kind];
  }

  rateLimitMode() {
    return this.rateLimitRemainPct !== null &&
      this.rateLimitRemainPct < RATE_LIMIT_SLOW_THRESHOLD_PCT
      ? "slow"
      : "normal";
  }

  updateRateLimit(result) {
    const pct = result?.rateLimit?.remainPct;
    if (Number.isFinite(Number(pct))) this.rateLimitRemainPct = Number(pct);
  }

  cacheFresh(cache, kind, { currentBtcAmount = null } = {}) {
    if (
      kind === "averageBuy" &&
      currentBtcAmount !== null &&
      cache?.currentBtcAmount !== currentBtcAmount
    ) {
      return false;
    }
    return Boolean(
      cache?.asOf && nowMs() - cache.asOf < this.intervalFor(kind)
    );
  }

  async fetchBtcTradeHistory() {
    const client = this.restClientFactory();
    const allTrades = [];
    const lookbackDays = configuredCostLookbackDays();
    const earliestMs = nowMs() - lookbackDays * 24 * 60 * 60 * 1_000;
    let windowToSec = Math.floor(nowMs() / 1_000);
    let historyComplete = true;

    while (windowToSec * 1_000 > earliestMs) {
      const windowFromSec = Math.max(
        Math.floor(earliestMs / 1_000),
        windowToSec - TRADE_WINDOW_DAYS * 24 * 60 * 60
      );

      for (let page = 1; page <= MAX_TRADE_PAGES_PER_WINDOW; page += 1) {
        const result = await client.getSpotMyTradesRaw({
          currencyPair: BTC_SPOT_PAIR,
          limit: String(TRADE_PAGE_LIMIT),
          page: String(page),
          from: String(windowFromSec),
          to: String(windowToSec),
        });
        this.updateRateLimit(result);
        if (!result.success) {
          const error = new Error(
            result.safeErrorMessage || "Gate BTC trade history failed."
          );
          error.partialFailure = {
            source: "average_buy",
            message: error.message,
          };
          throw error;
        }

        const pageTrades = Array.isArray(result.data) ? result.data : [];
        allTrades.push(...pageTrades);
        if (pageTrades.length < TRADE_PAGE_LIMIT) break;
        if (page === MAX_TRADE_PAGES_PER_WINDOW) historyComplete = false;
      }

      windowToSec = windowFromSec - 1;
    }

    return { trades: allTrades, historyComplete };
  }

  async marketData() {
    if (this.cacheFresh(this.marketCache, "market")) return this.marketCache;
    if (this.marketInFlight) return this.marketInFlight;

    this.marketInFlight = (async () => {
      const client = this.restClientFactory();
      const [ticker, candles] = await Promise.all([
        client.getSpotTickerRaw({ currencyPair: BTC_SPOT_PAIR }),
        client.getSpotCandlesticksRaw({
          currencyPair: BTC_SPOT_PAIR,
          interval: "30m",
          limit: "48",
        }),
      ]);
      this.updateRateLimit(ticker);
      this.updateRateLimit(candles);
      const partialFailures = [];
      const previous = this.marketCache || {};

      let tickerData = previous.tickerData || null;
      if (ticker.success) tickerData = normalizeTicker(ticker.data);
      else {
        partialFailures.push({
          source: "ticker",
          message: ticker.safeErrorMessage || "Gate BTC ticker failed",
        });
      }

      let candleData = previous.candles || [];
      if (candles.success) candleData = normalizeCandles(candles.data);
      else {
        partialFailures.push({
          source: "candles",
          message: candles.safeErrorMessage || "Gate BTC candles failed",
        });
      }

      if (!tickerData && !candleData.length) {
        throw new Error("Gate BTC market data failed.");
      }

      this.marketCache = {
        asOf: nowMs(),
        tickerData,
        candles: candleData,
        partialFailures,
      };
      return this.marketCache;
    })().finally(() => {
      this.marketInFlight = null;
    });

    return this.marketInFlight;
  }

  async balanceData() {
    if (this.cacheFresh(this.balanceCache, "balance")) return this.balanceCache;
    if (this.balanceInFlight) return this.balanceInFlight;

    this.balanceInFlight = (async () => {
      const result = await this.restClientFactory().getSpotAccountsRaw();
      this.updateRateLimit(result);
      if (!result.success) {
        throw new Error(result.safeErrorMessage || "Gate BTC balance failed.");
      }

      this.balanceCache = {
        asOf: nowMs(),
        btcAmount: normalizeBtcBalance(result.data),
      };
      return this.balanceCache;
    })().finally(() => {
      this.balanceInFlight = null;
    });

    return this.balanceInFlight;
  }

  async averageBuyData(currentBtcAmount = "0") {
    if (
      this.cacheFresh(this.averageBuyCache, "averageBuy", { currentBtcAmount })
    ) {
      return this.averageBuyCache;
    }
    if (this.averageBuyInFlight) return this.averageBuyInFlight;

    this.averageBuyInFlight = (async () => {
      try {
        const { trades, historyComplete } = await this.fetchBtcTradeHistory();
        const reconstructed = remainingCostFromTrades(trades, currentBtcAmount);
        const averageBuyPriceScope =
          reconstructed.averageBuyPriceUsd && !historyComplete
            ? "partial"
            : reconstructed.averageBuyPriceScope;
        this.averageBuyCache = {
          asOf: nowMs(),
          currentBtcAmount,
          ...reconstructed,
          averageBuyPriceScope,
          averageBuyHistoryComplete:
            historyComplete && reconstructed.averageBuyHistoryComplete,
        };
        return this.averageBuyCache;
      } catch (error) {
        this.averageBuyCache = {
          asOf: nowMs(),
          currentBtcAmount,
          averageBuyPriceUsd: null,
          averageBuyPriceScope: "unknown",
          averageBuyPriceMethod: "fifo_remaining_cost",
          averageBuyTradeCount: 0,
          averageBuyHistoryComplete: false,
          partialFailure: error?.partialFailure || {
            source: "average_buy",
            message: safeErrorMessage(error),
          },
        };
        return this.averageBuyCache;
      }
    })().finally(() => {
      this.averageBuyInFlight = null;
    });

    return this.averageBuyInFlight;
  }

  async summary({ range = "1d" } = {}) {
    if (range !== "1d") {
      const error = new Error("Only BTC 1d range is supported in v1.");
      error.code = "unsupported_btc_range";
      throw error;
    }

    const partialFailures = [];
    const [marketResult, balanceResult] = await Promise.allSettled([
      this.marketData(),
      this.balanceData(),
    ]);

    if (marketResult.status === "rejected") {
      partialFailures.push({
        source: "market",
        message: safeErrorMessage(marketResult.reason),
      });
    }
    if (balanceResult.status === "rejected") {
      partialFailures.push({
        source: "balance",
        message: safeErrorMessage(balanceResult.reason),
      });
    }
    const market =
      marketResult.status === "fulfilled"
        ? marketResult.value
        : this.marketCache;
    const balance =
      balanceResult.status === "fulfilled"
        ? balanceResult.value
        : this.balanceCache;

    const tickerData = market?.tickerData || null;
    if (!tickerData || !balance) {
      const error = new Error("Gate BTC summary failed");
      error.partialFailures = partialFailures;
      throw error;
    }

    const btcAmount = trimDecimal(balance.btcAmount || "0");
    let average = this.averageBuyCache;
    try {
      average = await this.averageBuyData(btcAmount);
    } catch (error) {
      partialFailures.push({
        source: "average_buy",
        message: safeErrorMessage(error),
      });
    }
    if (average?.partialFailure) partialFailures.push(average.partialFailure);

    const currentPriceUsd = tickerData.currentPriceUsd;
    const totalValueUsd = multiplyDecimalStrings(btcAmount, currentPriceUsd, {
      leftScale: 12,
      rightScale: 8,
      decimals: 2,
    });
    const asOf = Math.max(
      market?.asOf || 0,
      balance?.asOf || 0,
      average?.asOf || 0
    );

    return {
      success: true,
      asOf,
      exchange: "gate",
      symbol: BTC_SPOT_PAIR,
      connectionStatus: partialFailures.length ? "degraded" : "connected",
      totalValueUsd,
      btcAmount,
      averageBuyPriceUsd: average?.averageBuyPriceUsd || null,
      averageBuyPriceScope:
        average?.averageBuyPriceScope || "insufficient_history",
      averageBuyPriceMethod:
        average?.averageBuyPriceMethod || "fifo_remaining_cost",
      averageBuyTradeCount: average?.averageBuyTradeCount || 0,
      averageBuyHistoryComplete: Boolean(average?.averageBuyHistoryComplete),
      currentPriceUsd,
      change24hPct: tickerData.change24hPct,
      change24hUsd: tickerData.change24hUsd,
      candles: market?.candles || [],
      freshness: {
        latestSnapshotAt: asOf,
        priceAgeMs: market?.asOf ? nowMs() - market.asOf : null,
        balanceAgeMs: balance?.asOf ? nowMs() - balance.asOf : null,
        candleAgeMs: market?.asOf ? nowMs() - market.asOf : null,
        lastRefreshSource: "gate-rest",
        rateLimitMode: this.rateLimitMode(),
      },
      partialFailures,
    };
  }
}

const cryptoGateBtcSpotSummaryService = new GateBtcSpotSummaryService();

module.exports = {
  BTC_SPOT_PAIR,
  GateBtcSpotSummaryService,
  cryptoGateBtcSpotSummaryService,
  remainingCostFromTrades,
  normalizeCandles,
  normalizeTicker,
};
