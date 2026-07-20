const { GatePublicMarketClient } = require("../../../../cryptoGate");
const {
  MarketDataError,
  decimal,
  fetchJson,
  jsonTool,
  numeric,
  optionalString,
  requiredString,
} = require("../market-data/lib");

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

async function executeCryptoMarketSnapshot(input, dependencies = {}) {
  const { symbol, quote } = normalizedPair(input);
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
    "Query a public cryptocurrency market snapshot including current price, 24-hour change, volume, bid, ask, and spread. Dual mode compares Gate and Binance. This is read-only and never accesses private account data.",
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
    },
    required: ["symbol"],
    additionalProperties: false,
  },
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
  executeCryptoMarketSnapshot,
  executeCryptoPrice,
  normalizeBinanceTicker,
  normalizeGateTicker,
};
