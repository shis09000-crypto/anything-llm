const {
  GatePublicMarketClient,
  marketCandles,
  publicMarketSupportingEvidence,
} = require("../../../../cryptoGate");
const {
  MarketDataError,
  decimal,
  fetchJson,
  jsonTool,
  numeric,
  optionalString,
  requiredString,
} = require("../market-data/lib");
const {
  BARS_REQUESTED,
  TIMEFRAME_CONFIG,
  buildModelAnalysisView,
  buildQuantAnalysis,
  enforcePayloadBudget,
} = require("./quantAnalysis");
const { relativeStrength } = require("./supportingEvidence");
const { validatedCryptoMarketContinuation } = require("./interpretation");
const {
  PUBLIC_FORECAST_POLICY,
  SUPPORTED_SYMBOLS: FORECAST_SYMBOLS,
  monitoringOnlyForecastingView,
} = require("../../../../cryptoForecasting");
const { CryptoRuntime } = require("../../../../../modules/crypto");

const BINANCE_BASE_URL = "https://data-api.binance.vision/api/v3";

function normalizedPair(input) {
  const symbol = requiredString(input, "symbol").toUpperCase();
  const quote = optionalString(input, "quote", "USDT").toUpperCase();
  if (!/^[A-Z0-9]{2,20}$/.test(symbol) || !/^[A-Z0-9]{2,12}$/.test(quote))
    throw new MarketDataError(
      "invalid_input",
      "Invalid crypto symbol or quote."
    );
  return { symbol, quote };
}

function gatePair(symbol, quote) {
  return `${symbol}_${quote}`;
}

function binancePair(symbol, quote) {
  return `${symbol}${quote}`;
}

function normalizeGateTicker(data, symbol, quote) {
  const ticker = Array.isArray(data) ? data[0] : data;
  if (!ticker || typeof ticker !== "object")
    throw new MarketDataError(
      "pair_not_found",
      "Gate returned no ticker data."
    );
  const bid = numeric(ticker.highest_bid);
  const ask = numeric(ticker.lowest_ask);
  return {
    ok: true,
    exchange: "gate",
    pair: gatePair(symbol, quote),
    price: ticker.last || null,
    volume_24h: ticker.base_volume || null,
    quote_volume_24h: ticker.quote_volume || null,
    high_24h: ticker.high_24h || null,
    low_24h: ticker.low_24h || null,
    change_percent: ticker.change_percentage || null,
    best_bid: ticker.highest_bid || null,
    best_ask: ticker.lowest_ask || null,
    spread: bid !== null && ask !== null ? decimal(ask - bid) : null,
  };
}

async function queryGate(symbol, quote, client = new GatePublicMarketClient()) {
  const result = await client.getSpotTickerRaw({
    currencyPair: gatePair(symbol, quote),
  });
  if (!result?.success)
    throw new MarketDataError(
      "provider_unavailable",
      "Gate market data is unavailable."
    );
  return normalizeGateTicker(result.data, symbol, quote);
}

function normalizeBinanceTicker(ticker, symbol, quote) {
  if (!ticker || typeof ticker !== "object" || !ticker.lastPrice)
    throw new MarketDataError(
      "pair_not_found",
      "Binance returned no ticker data."
    );
  const bid = numeric(ticker.bidPrice);
  const ask = numeric(ticker.askPrice);
  return {
    ok: true,
    exchange: "binance",
    pair: binancePair(symbol, quote),
    price: ticker.lastPrice,
    volume_24h: ticker.volume || null,
    quote_volume_24h: ticker.quoteVolume || null,
    high_24h: ticker.highPrice || null,
    low_24h: ticker.lowPrice || null,
    change_percent: ticker.priceChangePercent || null,
    best_bid: ticker.bidPrice || null,
    best_ask: ticker.askPrice || null,
    spread: bid !== null && ask !== null ? decimal(ask - bid) : null,
  };
}

async function queryBinance(symbol, quote, fetchImpl = global.fetch) {
  const pair = binancePair(symbol, quote);
  const data = await fetchJson(
    `${BINANCE_BASE_URL}/ticker/24hr?symbol=${encodeURIComponent(pair)}`,
    { headers: { Accept: "application/json" } },
    fetchImpl
  );
  return normalizeBinanceTicker(data, symbol, quote);
}

function unavailable(exchange, error) {
  return {
    ok: false,
    exchange,
    error: error?.code || "provider_unavailable",
  };
}

function comparison(binance, gate) {
  const binancePrice = numeric(binance?.price);
  const gatePrice = numeric(gate?.price);
  if (binancePrice === null || gatePrice === null)
    return {
      reference_exchange: "binance",
      preferred_exchange: "gate",
      price_diff: null,
      price_diff_percent: null,
    };
  const diff = gatePrice - binancePrice;
  return {
    reference_exchange: "binance",
    preferred_exchange: "gate",
    price_diff: decimal(diff),
    price_diff_percent:
      binancePrice === 0 ? null : decimal((diff / binancePrice) * 100),
  };
}

async function executeCryptoPrice(input, dependencies = {}) {
  const { symbol, quote } = normalizedPair(input);
  const exchange = optionalString(input, "exchange", "gate").toLowerCase();
  const gate = () => queryGate(symbol, quote, dependencies.gateClient);
  const binance = () => queryBinance(symbol, quote, dependencies.fetchImpl);
  let ticker;
  if (exchange === "gate") ticker = await gate();
  else if (exchange === "binance") ticker = await binance();
  else if (exchange === "auto") {
    try {
      ticker = await gate();
    } catch {
      ticker = await binance();
    }
  } else {
    throw new MarketDataError("invalid_input", "Unsupported exchange.");
  }
  return {
    tool: "crypto_price",
    ok: true,
    symbol,
    quote,
    exchange: ticker.exchange,
    pair: ticker.pair,
    price: ticker.price,
    provider: ticker.exchange,
    source: `${ticker.exchange}_spot_ticker`,
    freshness: "near_realtime",
    cache_hit: false,
    note: "Public exchange data is for research reference only.",
    timestamp: new Date().toISOString(),
  };
}

async function executeSimpleCryptoMarketSnapshot(
  input,
  dependencies = {},
  normalized = normalizedPair(input)
) {
  const { symbol, quote } = normalized;
  const mode = optionalString(input, "exchange_mode", "dual").toLowerCase();
  const gate = () => queryGate(symbol, quote, dependencies.gateClient);
  const binance = () => queryBinance(symbol, quote, dependencies.fetchImpl);
  let gateResult = null;
  let binanceResult = null;

  if (mode === "gate") gateResult = await gate();
  else if (mode === "binance") binanceResult = await binance();
  else if (mode === "auto") {
    try {
      gateResult = await gate();
    } catch {
      binanceResult = await binance();
    }
  } else if (mode === "dual") {
    const [binanceSettled, gateSettled] = await Promise.allSettled([
      binance(),
      gate(),
    ]);
    binanceResult =
      binanceSettled.status === "fulfilled"
        ? binanceSettled.value
        : unavailable("binance", binanceSettled.reason);
    gateResult =
      gateSettled.status === "fulfilled"
        ? gateSettled.value
        : unavailable("gate", gateSettled.reason);
    if (!binanceResult.ok && !gateResult.ok)
      throw new MarketDataError(
        "providers_unavailable",
        "Gate and Binance market data are unavailable."
      );
  } else {
    throw new MarketDataError("invalid_input", "Unsupported exchange_mode.");
  }

  return {
    tool: "crypto_market_snapshot",
    ok: Boolean(gateResult?.ok || binanceResult?.ok),
    symbol,
    quote,
    exchange_mode: mode,
    sources: {
      binance: binanceResult || unavailable("binance"),
      gate: gateResult || unavailable("gate"),
    },
    comparison: comparison(binanceResult, gateResult),
    provider: mode,
    source: "public_spot_tickers",
    freshness: "near_realtime",
    cache_hit: false,
    note: "Public exchange data is for reference only.",
    timestamp: new Date().toISOString(),
  };
}

async function fetchAnalysisTimeframes({
  symbol,
  quote,
  marketCandlesImpl = marketCandles,
}) {
  const pair = gatePair(symbol, quote);
  const timeframeIds = Object.keys(TIMEFRAME_CONFIG);
  const settled = await Promise.allSettled(
    timeframeIds.map((range) =>
      marketCandlesImpl({
        pair,
        range,
        market: "spot",
        includeTicker: false,
        limit: BARS_REQUESTED,
      })
    )
  );
  const timeframePayloads = {};
  const partialFailures = [];
  settled.forEach((result, index) => {
    const timeframe = timeframeIds[index];
    if (
      result.status === "fulfilled" &&
      result.value?.success !== false &&
      Array.isArray(result.value?.candles) &&
      result.value.candles.length > 0
    ) {
      timeframePayloads[timeframe] = {
        candles: result.value.candles.slice(-BARS_REQUESTED),
        cacheHit: result.value.cacheHit === true,
        source: "gate",
      };
      return;
    }
    const error = result.status === "rejected" ? result.reason : result.value;
    partialFailures.push({
      source: "gate_candles",
      timeframe,
      error:
        error?.code ||
        error?.errorCode ||
        error?.error ||
        "provider_unavailable",
    });
  });
  return { timeframePayloads, partialFailures };
}

async function executeCryptoMarketSnapshot(input, dependencies = {}) {
  const normalized = normalizedPair(input);
  const analysisMode = optionalString(input, "mode", "simple").toLowerCase();
  if (!["simple", "analysis"].includes(analysisMode))
    throw new MarketDataError(
      "invalid_input",
      "Unsupported crypto market snapshot mode."
    );
  if (analysisMode === "simple")
    return executeSimpleCryptoMarketSnapshot(input, dependencies, normalized);

  const { symbol, quote } = normalized;
  const exchangeMode = optionalString(
    input,
    "exchange_mode",
    "dual"
  ).toLowerCase();
  if (!["gate", "binance", "dual", "auto"].includes(exchangeMode))
    throw new MarketDataError("invalid_input", "Unsupported exchange_mode.");
  const [snapshotResult, timeframeResult] = await Promise.allSettled([
    executeSimpleCryptoMarketSnapshot(
      { ...input, exchange_mode: "dual" },
      dependencies,
      normalized
    ),
    fetchAnalysisTimeframes({
      symbol,
      quote,
      marketCandlesImpl: dependencies.marketCandles || marketCandles,
    }),
  ]);
  const snapshot =
    snapshotResult.status === "fulfilled"
      ? snapshotResult.value
      : {
          tool: "crypto_market_snapshot",
          ok: false,
          error:
            snapshotResult.reason?.code ||
            snapshotResult.reason?.error ||
            "providers_unavailable",
        };
  const timeframePayloads =
    timeframeResult.status === "fulfilled"
      ? timeframeResult.value.timeframePayloads
      : {};
  const partialFailures =
    timeframeResult.status === "fulfilled"
      ? [...timeframeResult.value.partialFailures]
      : [
          {
            source: "gate_candles",
            timeframe: "all",
            error:
              timeframeResult.reason?.code ||
              timeframeResult.reason?.error ||
              "provider_unavailable",
          },
        ];
  if (snapshotResult.status === "rejected") {
    partialFailures.push({
      source: "spot_ticker_crosscheck",
      error:
        snapshotResult.reason?.code ||
        snapshotResult.reason?.error ||
        "providers_unavailable",
    });
  } else {
    for (const exchange of ["gate", "binance"]) {
      const source = snapshot.sources?.[exchange];
      if (source?.ok !== false) continue;
      partialFailures.push({
        source: "spot_ticker_crosscheck",
        exchange,
        error: source.error || "provider_unavailable",
      });
    }
  }

  const benchmarkResult =
    symbol === "BTC"
      ? { timeframePayloads: {}, partialFailures: [] }
      : await fetchAnalysisTimeframes({
          symbol: "BTC",
          quote,
          marketCandlesImpl: dependencies.marketCandles || marketCandles,
        });
  const relativeStrengthByTimeframe =
    symbol === "BTC"
      ? {}
      : Object.fromEntries(
          Object.keys(TIMEFRAME_CONFIG)
            .filter(
              (id) =>
                timeframePayloads[id]?.candles &&
                benchmarkResult.timeframePayloads[id]?.candles
            )
            .map((id) => [
              id,
              relativeStrength(
                timeframePayloads[id].candles,
                benchmarkResult.timeframePayloads[id].candles
              ),
            ])
        );
  for (const failure of benchmarkResult.partialFailures || [])
    partialFailures.push({
      ...failure,
      source: "gate_benchmark_candles",
      benchmark: "BTC_USDT",
    });

  const marketEvidenceResult = await Promise.resolve()
    .then(() =>
      (
        dependencies.publicMarketSupportingEvidence ||
        publicMarketSupportingEvidence
      )({
        pair: gatePair(symbol, quote),
        derivativesPair: gatePair(symbol, "USDT"),
        spotPrice:
          quote === "USDT" ? snapshot?.sources?.gate?.price || null : null,
        ...(dependencies.collectorManager
          ? { collectorManager: dependencies.collectorManager }
          : {}),
        ...(dependencies.derivativesClient
          ? { derivativesClient: dependencies.derivativesClient }
          : {}),
      })
    )
    .catch((error) => ({
      formulaVersion: "crypto-market-evidence-v1",
      status: "unavailable",
      spotMicrostructure: {
        status: "unavailable",
        error: error?.code || "provider_unavailable",
      },
      derivatives: {
        status: "unavailable",
        reason: error?.code || "provider_unavailable",
      },
    }));
  const forecastingMicrostructure = await Promise.resolve()
    .then(() => {
      if (dependencies.forecastingMicrostructureProvider)
        return dependencies.forecastingMicrostructureProvider({
          symbol,
          quote,
        });
      if (
        quote !== "USDT" ||
        !FORECAST_SYMBOLS.includes(symbol) ||
        !CryptoRuntime.forecasting.enabled()
      )
        return { status: "unavailable" };
      return CryptoRuntime.forecasting.microstructureEvidence(symbol);
    })
    .catch(() => ({ status: "unavailable" }));
  if (forecastingMicrostructure.status !== "unavailable") {
    marketEvidenceResult.spotMicrostructure = forecastingMicrostructure;
    const derivativesAvailable = ["complete", "partial"].includes(
      marketEvidenceResult.derivatives?.status
    );
    marketEvidenceResult.status =
      forecastingMicrostructure.status === "available" && derivativesAvailable
        ? "complete"
        : forecastingMicrostructure.status === "warming"
          ? "warming"
          : "partial";
  }
  for (const failure of marketEvidenceResult.derivatives?.failures || [])
    partialFailures.push({
      source: `gate_derivatives_${failure.source}`,
      error: failure.error,
    });
  if (marketEvidenceResult.derivatives?.reason)
    partialFailures.push({
      source: "gate_derivatives",
      error: marketEvidenceResult.derivatives.reason,
    });

  const quant = buildQuantAnalysis({
    timeframePayloads,
    partialFailures,
    marketEvidence: marketEvidenceResult,
    relativeStrengthByTimeframe,
  });
  if (quant.analysisStatus === "unavailable")
    throw new MarketDataError(
      "providers_unavailable",
      "Gate public candlestick data is unavailable."
    );

  const rawForecasting =
    FORECAST_SYMBOLS.includes(symbol) && quote === "USDT"
      ? await Promise.resolve()
          .then(() => {
            if (dependencies.forecastingProvider)
              return dependencies.forecastingProvider({ symbol, quote });
            if (!CryptoRuntime.forecasting.enabled())
              return {
                status: "unavailable",
                reason: "forecasting_runtime_disabled",
                horizons: {},
              };
            return CryptoRuntime.forecasting.latestForecasting(symbol);
          })
          .catch((error) => ({
            status: "unavailable",
            reason:
              error?.code ||
              error?.message ||
              "forecasting_runtime_unavailable",
            horizons: {},
          }))
      : {
          status: "unavailable",
          reason: "forecasting_asset_not_supported",
          horizons: {},
        };
  const forecasting = monitoringOnlyForecastingView(rawForecasting);

  return enforcePayloadBudget({
    tool: "crypto_market_snapshot",
    ok: true,
    mode: "analysis",
    symbol,
    quote,
    exchange_mode: exchangeMode,
    snapshot,
    provider: "gate",
    source: "public_spot_tickers_and_candles",
    sourceQuality: {
      status:
        partialFailures.length > 0 || marketEvidenceResult.status !== "complete"
          ? "degraded"
          : "complete",
      tickerCrosscheck: {
        required: true,
        gate: snapshot?.sources?.gate?.ok === true,
        binance: snapshot?.sources?.binance?.ok === true,
      },
      supportingEvidence: marketEvidenceResult.status,
      forecasting: forecasting.status,
    },
    freshness: "near_realtime",
    cache_hit:
      Object.values(timeframePayloads).length > 0 &&
      Object.values(timeframePayloads).every(
        (timeframe) => timeframe.cacheHit === true
      ),
    analysisPolicy: PUBLIC_FORECAST_POLICY,
    note: "Monitoring-only public market evidence. Current regimes and event conditions describe observed data; direct direction forecasts, directional probabilities, return targets, and trade instructions are disabled.",
    timestamp: new Date().toISOString(),
    forecasting,
    ...quant,
  });
}

function prepareCryptoMarketResultForModel(result, toolRun = null) {
  let parsed = result;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return result;
    }
  }
  if (!parsed || parsed.mode !== "analysis") return result;
  return JSON.stringify(buildModelAnalysisView(parsed, toolRun));
}

const cryptoPrice = jsonTool({
  name: "crypto_price",
  description:
    "Query the current public spot price for a cryptocurrency such as BTC, ETH, or SOL. Uses Gate by default and can use Binance or automatic fallback. This is read-only and never places orders.",
  examples: [
    { prompt: "比特币现在多少钱？", call: JSON.stringify({ symbol: "BTC" }) },
  ],
  parameters: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Asset code, for example BTC." },
      quote: {
        type: "string",
        description: "Quote currency; defaults to USDT.",
      },
      exchange: {
        type: "string",
        enum: ["gate", "binance", "auto"],
        description: "Public exchange source; defaults to gate.",
      },
    },
    required: ["symbol"],
    additionalProperties: false,
  },
  execute: executeCryptoPrice,
});

const cryptoMarketSnapshot = jsonTool({
  name: "crypto_market_snapshot",
  description:
    "Query a public cryptocurrency market snapshot. mode=simple returns the current price, 24-hour change, volume, bid, ask, spread, and optional Gate/Binance comparison. mode=analysis is monitoring-only: it adds Gate spot 1-hour, 4-hour, daily, and natural-week candles, deterministic quantitative indicators, Fibonacci levels, event-condition monitoring, data quality, spot microstructure, and derivatives context. Direct direction forecasts, directional probabilities, return targets, and trade instructions are disabled. This is read-only and never accesses private account data.",
  examples: [
    {
      prompt: "给我 ETH 的双交易所行情快照",
      call: JSON.stringify({ symbol: "ETH", exchange_mode: "dual" }),
    },
  ],
  parameters: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Asset code, for example ETH." },
      quote: {
        type: "string",
        description: "Quote currency; defaults to USDT.",
      },
      exchange_mode: {
        type: "string",
        enum: ["gate", "binance", "dual", "auto"],
        description: "Source mode; defaults to dual.",
      },
      mode: {
        type: "string",
        enum: ["simple", "analysis"],
        description:
          "Response mode. Defaults to simple for backward compatibility.",
      },
    },
    required: ["symbol"],
    additionalProperties: false,
  },
  continuationTask: "crypto_market_analysis",
  continuationInstruction:
    "The crypto analysis result is monitoring-only. Describe observed closed-candle regimes, indicator values, event conditions, data quality, spot microstructure, and derivatives context. Never provide a future direction, directional probability, return or price target, trade instruction, or investment recommendation. Do not relabel regimes; infer divergence, indicator sign changes, crossovers, calendar timing, causal effects, or strengthening/weakening from one latest value; call Fibonacci reference levels support/resistance without an explicit label; confuse volume ratio with day-over-day volume; invent numbers; or write inequalities that conflict with indicator relations.",
  prepareResultForModel: prepareCryptoMarketResultForModel,
  modelResultMaxChars: 20_000,
  validatedContinuation: validatedCryptoMarketContinuation,
  execute: executeCryptoMarketSnapshot,
});

const cryptoMarketAgent = {
  name: "crypto-market-agent",
  startupConfig: { params: {} },
  plugin: [cryptoPrice, cryptoMarketSnapshot],
};

module.exports = {
  BINANCE_BASE_URL,
  cryptoMarketAgent,
  executeSimpleCryptoMarketSnapshot,
  executeCryptoMarketSnapshot,
  executeCryptoPrice,
  fetchAnalysisTimeframes,
  normalizeBinanceTicker,
  normalizeGateTicker,
  prepareCryptoMarketResultForModel,
};
