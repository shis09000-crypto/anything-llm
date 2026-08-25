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

const NORMAL_INTERVALS = {
  ticker: 5_000,
  balance: 10_000,
  averageBuy: 5 * 60_000,
};
const SLOW_INTERVALS = {
  ticker: 15_000,
  balance: 30_000,
  averageBuy: 10 * 60_000,
};
const RATE_LIMIT_SLOW_THRESHOLD_PCT = 20;
const TRADE_PAGE_LIMIT = 1000;
const TRADE_WINDOW_DAYS = 30;
const DEFAULT_COST_LOOKBACK_DAYS = 365;
const MAX_TRADE_PAGES_PER_WINDOW = 100;
const AVERAGE_BUY_CALCULATING_GRACE_MS = 15_000;
const DEFAULT_RECENT_BUY_WINDOW_BY_PAIR = {
  BTC_USDT: 162,
};
const AMOUNT_SCALE = 12;
const PRICE_SCALE = 8;
const COST_SCALE = AMOUNT_SCALE + PRICE_SCALE;
const BALANCE_TOLERANCE_SCALED = toScaledInt("0.000001", AMOUNT_SCALE);

function nowMs() {
  return Date.now();
}

function parseGateSpotPair(pair) {
  const normalized = String(pair || "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z0-9]{2,20}_[A-Z0-9]{2,20}$/.test(normalized)) {
    const error = new Error("Unsupported or invalid Gate spot pair.");
    error.code = "invalid_pair";
    throw error;
  }

  const [baseAsset, quoteAsset] = normalized.split("_");
  return {
    baseAsset,
    quoteAsset,
    gateCurrencyPair: normalized,
    symbol: `${baseAsset}/${quoteAsset}`,
  };
}

function positiveString(value, fallback = "0") {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? String(value) : fallback;
}

function normalizeTicker(data, pair) {
  const ticker = Array.isArray(data) ? data[0] : data;
  if (!ticker || typeof ticker !== "object") {
    throw new Error(`Gate ticker response was empty for ${pair}.`);
  }

  const last = positiveString(ticker.last || ticker.close, null);
  if (!last)
    throw new Error(`Gate ticker last price was not found for ${pair}.`);

  const change24hPct =
    ticker.change_percentage ??
    ticker.change_utc0 ??
    ticker.change_utc8 ??
    ticker.change;

  return {
    currentPriceQuote: String(last),
    change24hPct:
      change24hPct === undefined || change24hPct === null
        ? null
        : String(change24hPct),
  };
}

function normalizeSpotBalance(data, baseAsset) {
  if (!Array.isArray(data)) {
    throw new Error("Gate spot accounts response was empty.");
  }

  const account = data.find(
    (item) => String(item?.currency || "").toUpperCase() === baseAsset
  );
  if (!account) return "0";

  return addDecimalStrings([account.available || "0", account.locked || "0"], {
    scale: AMOUNT_SCALE,
    decimals: 8,
  });
}

function normalizeEarnUniBalance(data, baseAsset) {
  if (!Array.isArray(data)) return "0";
  const rows = data.filter(
    (item) => String(item?.currency || "").toUpperCase() === baseAsset
  );
  if (!rows.length) return "0";

  return addDecimalStrings(
    rows.map((row) => row.amount || row.lent_amount || "0"),
    { scale: AMOUNT_SCALE, decimals: 8 }
  );
}

function configuredCostLookbackDays() {
  const value = Number(process.env.GATE_TRADING_PAIR_COST_LOOKBACK_DAYS);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_COST_LOOKBACK_DAYS;
  return Math.max(30, Math.min(3650, Math.round(value)));
}

function configuredRecentBuyWindow(pair) {
  const envKey = `GATE_TRADING_PAIR_RECENT_BUY_COUNT_${String(pair || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")}`;
  const configured = Number(process.env[envKey]);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1, Math.round(configured));
  }
  return DEFAULT_RECENT_BUY_WINDOW_BY_PAIR[pair] || null;
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

function remainingCostFromTrades(
  trades = [],
  currentBaseAmount = "0",
  { baseAsset, quoteAsset, gateCurrencyPair }
) {
  const currentAmountScaled = toScaledInt(currentBaseAmount, AMOUNT_SCALE);
  if (currentAmountScaled <= 0n) {
    return {
      averageBuyPriceQuote: null,
      averageBuyPriceMethod: "unknown",
      averageBuyPriceScope: "unknown",
      averageBuyTradeCount: 0,
      averageBuyHistoryComplete: false,
    };
  }

  const lots = [];
  let buyTradeCount = 0;
  let unmatchedSellAmountScaled = 0n;
  let movingAmountScaled = 0n;
  let movingCostScaled = 0n;

  const sortedTrades = [...trades]
    .filter((trade) => tradeTimestamp(trade) > 0)
    .sort((left, right) => tradeTimestamp(left) - tradeTimestamp(right));

  for (const trade of sortedTrades) {
    const side = String(trade?.side || "").toLowerCase();
    const amountScaled = tradeAmountScaled(trade);
    const priceScaled = tradePriceScaled(trade);
    if (amountScaled <= 0n || priceScaled <= 0n) continue;

    if (side === "buy") {
      const baseFeeScaled = tradeFeeScaled(trade, baseAsset, AMOUNT_SCALE);
      const quoteFeeScaled = tradeFeeScaled(trade, quoteAsset, COST_SCALE);
      const receivedAmountScaled = amountScaled - baseFeeScaled;
      if (receivedAmountScaled <= 0n) continue;
      lots.push({
        amountScaled: receivedAmountScaled,
        costScaled: amountScaled * priceScaled + quoteFeeScaled,
      });
      movingAmountScaled += receivedAmountScaled;
      movingCostScaled += amountScaled * priceScaled + quoteFeeScaled;
      buyTradeCount += 1;
    }

    if (side === "sell") {
      unmatchedSellAmountScaled += applySellToLots(lots, amountScaled);
      if (movingAmountScaled > 0n) {
        const sellAmount =
          amountScaled > movingAmountScaled ? movingAmountScaled : amountScaled;
        const costReduction = divideRounded(
          movingCostScaled * sellAmount,
          movingAmountScaled
        );
        movingAmountScaled -= sellAmount;
        movingCostScaled -= costReduction;
      }
    }
  }

  const recentBuyWindow = configuredRecentBuyWindow(gateCurrencyPair);
  const recentBuyTrades = recentBuyWindow
    ? sortedTrades
        .filter((trade) => String(trade?.side || "").toLowerCase() === "buy")
        .slice(-recentBuyWindow)
    : [];
  const recentBuyAmountScaled = recentBuyTrades.reduce(
    (sum, trade) => sum + tradeAmountScaled(trade),
    0n
  );
  const recentBuyCostScaled = recentBuyTrades.reduce((sum, trade) => {
    const amountScaled = tradeAmountScaled(trade);
    const priceScaled = tradePriceScaled(trade);
    if (amountScaled <= 0n || priceScaled <= 0n) return sum;
    return sum + amountScaled * priceScaled;
  }, 0n);

  const reconstructedAmountScaled = lots.reduce(
    (sum, lot) => sum + lot.amountScaled,
    0n
  );
  const diffScaled = reconstructedAmountScaled - currentAmountScaled;
  const historyMatchesBalance =
    absBigInt(diffScaled) <= BALANCE_TOLERANCE_SCALED &&
    unmatchedSellAmountScaled === 0n;

  if (!historyMatchesBalance || reconstructedAmountScaled <= 0n) {
    const recentWindowAverage = averagePriceFromCost({
      costScaled: recentBuyCostScaled,
      amountScaled: recentBuyAmountScaled,
      decimals: 2,
    });
    if (recentWindowAverage) {
      return {
        averageBuyPriceQuote: recentWindowAverage,
        averageBuyPriceMethod: "recent_weighted",
        averageBuyPriceScope: "partial",
        averageBuyTradeCount: recentBuyTrades.length,
        averageBuyHistoryComplete: false,
        averageBuyWindow: {
          type: "recent_buy_count",
          count: recentBuyTrades.length,
          configuredCount: recentBuyWindow,
        },
        reconstructedBaseAmount: trimDecimal(
          formatScaledInt(reconstructedAmountScaled, AMOUNT_SCALE, 8)
        ),
      };
    }

    const fallbackAverage = averagePriceFromCost({
      costScaled: movingCostScaled,
      amountScaled: movingAmountScaled,
      decimals: 2,
    });
    if (fallbackAverage) {
      return {
        averageBuyPriceQuote: fallbackAverage,
        averageBuyPriceMethod: "moving_weighted",
        averageBuyPriceScope: "partial",
        averageBuyTradeCount: buyTradeCount,
        averageBuyHistoryComplete: false,
        reconstructedBaseAmount: trimDecimal(
          formatScaledInt(reconstructedAmountScaled, AMOUNT_SCALE, 8)
        ),
      };
    }

    return {
      averageBuyPriceQuote: null,
      averageBuyPriceMethod: "unknown",
      averageBuyPriceScope: "insufficient_history",
      averageBuyTradeCount: buyTradeCount,
      averageBuyHistoryComplete: false,
      reconstructedBaseAmount: trimDecimal(
        formatScaledInt(reconstructedAmountScaled, AMOUNT_SCALE, 8)
      ),
    };
  }

  const remainingCostScaled = lots.reduce(
    (sum, lot) => sum + lot.costScaled,
    0n
  );
  return {
    averageBuyPriceQuote: averagePriceFromCost({
      costScaled: remainingCostScaled,
      amountScaled: reconstructedAmountScaled,
      decimals: 2,
    }),
    averageBuyPriceMethod: "moving_weighted",
    averageBuyPriceScope: "full",
    averageBuyTradeCount: buyTradeCount,
    averageBuyHistoryComplete: true,
    averageBuyWindow: {
      type: "fifo_remaining_cost",
      count: buyTradeCount,
    },
    reconstructedBaseAmount: trimDecimal(
      formatScaledInt(reconstructedAmountScaled, AMOUNT_SCALE, 8)
    ),
  };
}

function previousPriceFromPct(currentPriceQuote, change24hPct) {
  const current = Number(currentPriceQuote);
  const pct = Number(change24hPct);
  if (!Number.isFinite(current) || !Number.isFinite(pct)) return null;
  const divisor = 1 + pct / 100;
  if (!Number.isFinite(divisor) || divisor === 0) return null;
  return current / divisor;
}

function changeQuoteForHolding({
  holdingAmountBase,
  currentPriceQuote,
  change24hPct,
}) {
  const previous = previousPriceFromPct(currentPriceQuote, change24hPct);
  const current = Number(currentPriceQuote);
  const holding = Number(holdingAmountBase);
  if (
    previous === null ||
    !Number.isFinite(current) ||
    !Number.isFinite(holding)
  ) {
    return null;
  }
  return ((current - previous) * holding).toFixed(2);
}

class GateTradingPairDetailService {
  constructor({ restClientFactory = () => new GateRestClient() } = {}) {
    this.restClientFactory = restClientFactory;
    this.tickerCache = new Map();
    this.balanceCache = null;
    this.averageBuyCache = new Map();
    this.tickerInFlight = new Map();
    this.balanceInFlight = null;
    this.averageBuyInFlight = new Map();
    this.averageBuyStartedAt = new Map();
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

  cacheFresh(cache, kind) {
    return Boolean(
      cache?.asOf && nowMs() - cache.asOf < this.intervalFor(kind)
    );
  }

  async tickerData(pairInfo) {
    const cached = this.tickerCache.get(pairInfo.gateCurrencyPair);
    if (this.cacheFresh(cached, "ticker")) return cached;
    const inFlight = this.tickerInFlight.get(pairInfo.gateCurrencyPair);
    if (inFlight) return inFlight;

    const request = (async () => {
      const result = await this.restClientFactory().getSpotTickerRaw({
        currencyPair: pairInfo.gateCurrencyPair,
      });
      this.updateRateLimit(result);
      if (!result.success) {
        throw new Error(result.safeErrorMessage || "Gate ticker failed.");
      }
      const cache = {
        asOf: nowMs(),
        tickerData: normalizeTicker(result.data, pairInfo.gateCurrencyPair),
      };
      this.tickerCache.set(pairInfo.gateCurrencyPair, cache);
      return cache;
    })().finally(() => {
      this.tickerInFlight.delete(pairInfo.gateCurrencyPair);
    });

    this.tickerInFlight.set(pairInfo.gateCurrencyPair, request);
    return request;
  }

  async balanceData() {
    if (this.cacheFresh(this.balanceCache, "balance")) return this.balanceCache;
    if (this.balanceInFlight) return this.balanceInFlight;

    this.balanceInFlight = (async () => {
      const client = this.restClientFactory();
      const [spotResult, earnResult] = await Promise.allSettled([
        client.getSpotAccountsRaw(),
        client.getEarnUniLendsRaw(),
      ]);

      const partialFailures = [];
      if (spotResult.status === "fulfilled")
        this.updateRateLimit(spotResult.value);
      if (earnResult.status === "fulfilled")
        this.updateRateLimit(earnResult.value);

      if (spotResult.status !== "fulfilled" || !spotResult.value.success) {
        const message =
          spotResult.status === "fulfilled"
            ? spotResult.value.safeErrorMessage
            : safeErrorMessage(spotResult.reason);
        throw new Error(message || "Gate spot balance failed.");
      }

      if (earnResult.status !== "fulfilled" || !earnResult.value.success) {
        partialFailures.push({
          source: "earn_uni_lends",
          message:
            earnResult.status === "fulfilled"
              ? earnResult.value.safeErrorMessage || "Gate earn balance failed."
              : safeErrorMessage(earnResult.reason),
        });
      }

      this.balanceCache = {
        asOf: nowMs(),
        accounts: Array.isArray(spotResult.value.data)
          ? spotResult.value.data
          : [],
        earnUniLends:
          earnResult.status === "fulfilled" &&
          earnResult.value.success &&
          Array.isArray(earnResult.value.data)
            ? earnResult.value.data
            : [],
        partialFailures,
      };
      return this.balanceCache;
    })().finally(() => {
      this.balanceInFlight = null;
    });

    return this.balanceInFlight;
  }

  async fetchTradeHistory(pairInfo) {
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
          currencyPair: pairInfo.gateCurrencyPair,
          limit: String(TRADE_PAGE_LIMIT),
          page: String(page),
          from: String(windowFromSec),
          to: String(windowToSec),
        });
        this.updateRateLimit(result);
        if (!result.success) {
          const error = new Error(
            result.safeErrorMessage || "Gate trade history failed."
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

  async averageBuyData(pairInfo, holdingAmountBase) {
    const cacheKey = `${pairInfo.gateCurrencyPair}:${holdingAmountBase}`;
    const cached = this.averageBuyCache.get(cacheKey);
    if (this.cacheFresh(cached, "averageBuy")) return cached;
    const inFlight = this.averageBuyInFlight.get(cacheKey);
    if (inFlight) return inFlight;

    this.averageBuyStartedAt.set(cacheKey, nowMs());
    const request = (async () => {
      try {
        const { trades, historyComplete } =
          await this.fetchTradeHistory(pairInfo);
        const reconstructed = remainingCostFromTrades(
          trades,
          holdingAmountBase,
          {
            baseAsset: pairInfo.baseAsset,
            quoteAsset: pairInfo.quoteAsset,
            gateCurrencyPair: pairInfo.gateCurrencyPair,
          }
        );
        const averageBuyPriceScope =
          reconstructed.averageBuyPriceQuote && !historyComplete
            ? "partial"
            : reconstructed.averageBuyPriceScope;
        const cache = {
          asOf: nowMs(),
          ...reconstructed,
          averageBuyPriceScope,
          averageBuyHistoryComplete:
            historyComplete && reconstructed.averageBuyHistoryComplete,
        };
        this.averageBuyCache.set(cacheKey, cache);
        return cache;
      } catch (error) {
        const cache = {
          asOf: nowMs(),
          averageBuyPriceQuote: null,
          averageBuyPriceMethod: "unknown",
          averageBuyPriceScope: "unknown",
          averageBuyTradeCount: 0,
          averageBuyHistoryComplete: false,
          partialFailure: error?.partialFailure || {
            source: "average_buy",
            message: safeErrorMessage(error),
          },
        };
        this.averageBuyCache.set(cacheKey, cache);
        return cache;
      }
    })().finally(() => {
      this.averageBuyInFlight.delete(cacheKey);
      this.averageBuyStartedAt.delete(cacheKey);
    });

    this.averageBuyInFlight.set(cacheKey, request);
    return request;
  }

  averageBuySnapshot(pairInfo, holdingAmountBase) {
    const cacheKey = `${pairInfo.gateCurrencyPair}:${holdingAmountBase}`;
    const cached = this.averageBuyCache.get(cacheKey);
    if (this.cacheFresh(cached, "averageBuy")) return cached;
    const inFlight = this.averageBuyInFlight.get(cacheKey);
    if (!inFlight) {
      this.averageBuyData(pairInfo, holdingAmountBase).catch(() => {});
    } else if (cached) {
      return cached;
    } else {
      const startedAt = this.averageBuyStartedAt.get(cacheKey) || nowMs();
      if (nowMs() - startedAt > AVERAGE_BUY_CALCULATING_GRACE_MS) {
        return {
          asOf: nowMs(),
          averageBuyPriceQuote: null,
          averageBuyPriceMethod: "unknown",
          averageBuyPriceScope: "unknown",
          averageBuyTradeCount: 0,
          averageBuyHistoryComplete: false,
        };
      }
    }
    return {
      asOf: cached?.asOf || nowMs(),
      averageBuyPriceQuote: cached?.averageBuyPriceQuote || null,
      averageBuyPriceMethod: cached?.averageBuyPriceMethod || "unknown",
      averageBuyPriceScope: "calculating",
      averageBuyTradeCount: cached?.averageBuyTradeCount || 0,
      averageBuyHistoryComplete: Boolean(cached?.averageBuyHistoryComplete),
    };
  }

  async detail({ pair = "BTC_USDT", market = "spot" } = {}) {
    if (String(market || "").toLowerCase() !== "spot") {
      const error = new Error("Gate API Mode 暂仅支持现货交易对。");
      error.code = "unsupported_market";
      throw error;
    }

    const pairInfo = parseGateSpotPair(pair);
    const partialFailures = [];
    const [tickerResult, balanceResult] = await Promise.allSettled([
      this.tickerData(pairInfo),
      this.balanceData(),
    ]);

    if (tickerResult.status === "rejected") {
      partialFailures.push({
        source: "ticker",
        message: safeErrorMessage(tickerResult.reason),
      });
    }
    if (balanceResult.status === "rejected") {
      partialFailures.push({
        source: "balance",
        message: safeErrorMessage(balanceResult.reason),
      });
    }

    const ticker =
      tickerResult.status === "fulfilled"
        ? tickerResult.value
        : this.tickerCache.get(pairInfo.gateCurrencyPair);
    const balance =
      balanceResult.status === "fulfilled"
        ? balanceResult.value
        : this.balanceCache;

    if (!ticker?.tickerData || !balance?.accounts) {
      const error = new Error("Gate trading pair detail failed.");
      error.partialFailures = partialFailures;
      throw error;
    }

    const holdingAmountBase = normalizeSpotBalance(
      balance.accounts,
      pairInfo.baseAsset
    );
    const earnAmountBase = normalizeEarnUniBalance(
      balance.earnUniLends,
      pairInfo.baseAsset
    );
    const totalHoldingAmountBase = addDecimalStrings(
      [holdingAmountBase, earnAmountBase],
      { scale: AMOUNT_SCALE, decimals: 8 }
    );
    const currentPriceQuote = ticker.tickerData.currentPriceQuote;
    const holdingValueQuote = multiplyDecimalStrings(
      totalHoldingAmountBase,
      currentPriceQuote,
      {
        leftScale: AMOUNT_SCALE,
        rightScale: PRICE_SCALE,
        decimals: 2,
      }
    );
    const change24hQuote = changeQuoteForHolding({
      holdingAmountBase: totalHoldingAmountBase,
      currentPriceQuote,
      change24hPct: ticker.tickerData.change24hPct,
    });

    if (Array.isArray(balance.partialFailures)) {
      partialFailures.push(...balance.partialFailures);
    }

    // Price and balance are the critical path for the asset card. Historical
    // cost reconstruction may scan many Gate trade-history windows, so start it
    // in the background and return a calculating snapshot immediately.
    const average = this.averageBuySnapshot(pairInfo, totalHoldingAmountBase);
    if (average?.partialFailure) partialFailures.push(average.partialFailure);

    const asOf = Math.max(
      ticker?.asOf || 0,
      balance?.asOf || 0,
      average?.asOf || 0
    );

    return {
      success: true,
      asOf,
      exchange: "gate",
      ...pairInfo,
      marketType: "spot",
      connectionStatus: partialFailures.length ? "degraded" : "connected",
      holdingValueQuote,
      holdingValueUsd:
        pairInfo.quoteAsset === "USDT" || pairInfo.quoteAsset === "USD"
          ? holdingValueQuote
          : null,
      change24hPct: ticker.tickerData.change24hPct,
      change24hQuote,
      averageBuyPriceQuote: average?.averageBuyPriceQuote || null,
      averageBuyPriceMethod: average?.averageBuyPriceMethod || "unknown",
      averageBuyPriceScope: average?.averageBuyPriceScope || "unknown",
      averageBuyTradeCount: average?.averageBuyTradeCount || 0,
      averageBuyHistoryComplete: Boolean(average?.averageBuyHistoryComplete),
      averageBuyWindow: average?.averageBuyWindow || null,
      currentPriceQuote,
      holdingAmountBase: trimDecimal(totalHoldingAmountBase),
      holdingSources: {
        spot: trimDecimal(holdingAmountBase),
        earnUni: trimDecimal(earnAmountBase),
        selected: "combined",
      },
      lastUpdatedAt: asOf,
      freshness: {
        latestSnapshotAt: asOf,
        tickerAgeMs: ticker?.asOf ? nowMs() - ticker.asOf : null,
        balanceAgeMs: balance?.asOf ? nowMs() - balance.asOf : null,
        averageBuyAgeMs: average?.asOf ? nowMs() - average.asOf : null,
        lastRefreshSource: "gate-rest",
        rateLimitMode: this.rateLimitMode(),
      },
      partialFailures,
    };
  }
}

const cryptoGateTradingPairDetailService = new GateTradingPairDetailService();

module.exports = {
  GateTradingPairDetailService,
  cryptoGateTradingPairDetailService,
  parseGateSpotPair,
  remainingCostFromTrades,
};
