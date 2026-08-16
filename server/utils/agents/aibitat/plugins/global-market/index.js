const {
  MarketDataError,
  decimal,
  fetchJson,
  fetchText,
  jsonTool,
  numeric,
  optionalString,
  requiredString,
} = require("../market-data/lib");
const { readManagedSecret } = require("../market-data/secrets");

const STOOQ_BASE_URL = "https://stooq.com/q/l/";
const JUHE_FOREX_URL = "https://op.juhe.cn/onebox/exchange/currency";
const JUHE_STOCK_BASE_URL = "https://web.juhe.cn/finance/stock";
const FRANKFURTER_URL = "https://api.frankfurter.dev/v1/latest";
const NASDAQ_QUOTE_BASE_URL = "https://api.nasdaq.com/api/quote";
const GOLD_API_BASE_URL = "https://api.gold-api.com/price";

const INDEXES = Object.freeze({
  NASDAQ100: ["^ndx", "Nasdaq 100", "US", "America", "USD"],
  NASDAQ_100: ["^ndx", "Nasdaq 100", "US", "America", "USD"],
  NDX: ["^ndx", "Nasdaq 100", "US", "America", "USD"],
  NAS100: ["^ndx", "Nasdaq 100", "US", "America", "USD"],
  NASDAQ: ["^ndq", "Nasdaq Composite", "US", "America", "USD"],
  IXIC: ["^ndq", "Nasdaq Composite", "US", "America", "USD"],
  NASDAQ_COMPOSITE: ["^ndq", "Nasdaq Composite", "US", "America", "USD"],
  SP500: ["^spx", "S&P 500", "US", "America", "USD"],
  "S&P500": ["^spx", "S&P 500", "US", "America", "USD"],
  SPX: ["^spx", "S&P 500", "US", "America", "USD"],
  GSPC: ["^spx", "S&P 500", "US", "America", "USD"],
  DOW: ["^dji", "Dow Jones Industrial Average", "US", "America", "USD"],
  DJI: ["^dji", "Dow Jones Industrial Average", "US", "America", "USD"],
  DOWJONES: ["^dji", "Dow Jones Industrial Average", "US", "America", "USD"],
  HSI: ["^hsi", "Hang Seng Index", "HK", "Asia", "HKD"],
  HANGSENG: ["^hsi", "Hang Seng Index", "HK", "Asia", "HKD"],
  恒生: ["^hsi", "Hang Seng Index", "HK", "Asia", "HKD"],
  恒生指数: ["^hsi", "Hang Seng Index", "HK", "Asia", "HKD"],
  SSE: ["^shc", "Shanghai Composite Index", "CN", "Asia", "CNY"],
  SHANGHAI: ["^shc", "Shanghai Composite Index", "CN", "Asia", "CNY"],
  上证: ["^shc", "Shanghai Composite Index", "CN", "Asia", "CNY"],
  上证指数: ["^shc", "Shanghai Composite Index", "CN", "Asia", "CNY"],
  NIKKEI: ["^nkx", "Nikkei 225", "JP", "Asia", "JPY"],
  NIKKEI225: ["^nkx", "Nikkei 225", "JP", "Asia", "JPY"],
  日经: ["^nkx", "Nikkei 225", "JP", "Asia", "JPY"],
  FTSE: ["^ukx", "FTSE 100", "UK", "Europe", "GBP"],
  FTSE100: ["^ukx", "FTSE 100", "UK", "Europe", "GBP"],
  DAX: ["^dax", "DAX", "DE", "Europe", "EUR"],
  德国DAX: ["^dax", "DAX", "DE", "Europe", "EUR"],
});

const JUHE_US_INDEX_FALLBACKS = Object.freeze({
  NASDAQ: "IXIC",
  IXIC: "IXIC",
  NASDAQ_COMPOSITE: "IXIC",
  SP500: "INX",
  "S&P500": "INX",
  SPX: "INX",
  GSPC: "INX",
  DOW: "DJI",
  DJI: "DJI",
  DOWJONES: "DJI",
});

const COMMODITIES = Object.freeze({
  WTI: ["cl.f", "Crude Oil WTI Futures", "energy", "USD per barrel"],
  WTI_OIL: ["cl.f", "Crude Oil WTI Futures", "energy", "USD per barrel"],
  CRUDE: ["cl.f", "Crude Oil WTI Futures", "energy", "USD per barrel"],
  原油: ["cl.f", "Crude Oil WTI Futures", "energy", "USD per barrel"],
  BRENT: ["cb.f", "Brent Crude Oil Futures", "energy", "USD per barrel"],
  布伦特: ["cb.f", "Brent Crude Oil Futures", "energy", "USD per barrel"],
  布伦特原油: ["cb.f", "Brent Crude Oil Futures", "energy", "USD per barrel"],
  NATGAS: ["ng.f", "Natural Gas Futures", "energy", "USD per MMBtu"],
  NATURALGAS: ["ng.f", "Natural Gas Futures", "energy", "USD per MMBtu"],
  天然气: ["ng.f", "Natural Gas Futures", "energy", "USD per MMBtu"],
  GASOLINE: ["rb.f", "RBOB Gasoline Futures", "energy", "USD per gallon"],
  汽油: ["rb.f", "RBOB Gasoline Futures", "energy", "USD per gallon"],
  GOLD: ["gc.f", "Gold Futures", "precious_metal", "USD per troy ounce"],
  XAU: ["gc.f", "Gold Futures", "precious_metal", "USD per troy ounce"],
  黄金: ["gc.f", "Gold Futures", "precious_metal", "USD per troy ounce"],
  SILVER: ["si.f", "Silver Futures", "precious_metal", "USD per troy ounce"],
  XAG: ["si.f", "Silver Futures", "precious_metal", "USD per troy ounce"],
  白银: ["si.f", "Silver Futures", "precious_metal", "USD per troy ounce"],
  PLATINUM: [
    "pl.f",
    "Platinum Futures",
    "precious_metal",
    "USD per troy ounce",
  ],
  铂金: ["pl.f", "Platinum Futures", "precious_metal", "USD per troy ounce"],
  PALLADIUM: [
    "pa.f",
    "Palladium Futures",
    "precious_metal",
    "USD per troy ounce",
  ],
  钯金: ["pa.f", "Palladium Futures", "precious_metal", "USD per troy ounce"],
  COPPER: ["hg.f", "Copper Futures", "industrial_metal", "USD per pound"],
  铜: ["hg.f", "Copper Futures", "industrial_metal", "USD per pound"],
  ALUMINUM: ["ali.f", "Aluminum Futures", "industrial_metal", "USD per tonne"],
  铝: ["ali.f", "Aluminum Futures", "industrial_metal", "USD per tonne"],
  NICKEL: ["nic.f", "Nickel Futures", "industrial_metal", "USD per tonne"],
  镍: ["nic.f", "Nickel Futures", "industrial_metal", "USD per tonne"],
  LEAD: ["led.f", "Lead Futures", "industrial_metal", "USD per tonne"],
  铅: ["led.f", "Lead Futures", "industrial_metal", "USD per tonne"],
  ZINC: ["znc.f", "Zinc Futures", "industrial_metal", "USD per tonne"],
  锌: ["znc.f", "Zinc Futures", "industrial_metal", "USD per tonne"],
  SOYBEAN: ["s.f", "Soybeans Futures", "agriculture", "US cents per bushel"],
  大豆: ["s.f", "Soybeans Futures", "agriculture", "US cents per bushel"],
  WHEAT: ["w.f", "Wheat Futures", "agriculture", "US cents per bushel"],
  小麦: ["w.f", "Wheat Futures", "agriculture", "US cents per bushel"],
  CORN: ["c.f", "Corn Futures", "agriculture", "US cents per bushel"],
  玉米: ["c.f", "Corn Futures", "agriculture", "US cents per bushel"],
  COFFEE: ["kc.f", "Coffee Futures", "agriculture", "US cents per pound"],
  咖啡: ["kc.f", "Coffee Futures", "agriculture", "US cents per pound"],
  COCOA: ["cc.f", "Cocoa Futures", "agriculture", "USD per metric ton"],
  可可: ["cc.f", "Cocoa Futures", "agriculture", "USD per metric ton"],
  SUGAR: ["sb.f", "Sugar Futures", "agriculture", "US cents per pound"],
  糖: ["sb.f", "Sugar Futures", "agriculture", "US cents per pound"],
  COTTON: ["ct.f", "Cotton Futures", "agriculture", "US cents per pound"],
  棉花: ["ct.f", "Cotton Futures", "agriculture", "US cents per pound"],
  ORANGEJUICE: [
    "oj.f",
    "Orange Juice Futures",
    "agriculture",
    "US cents per pound",
  ],
  橙汁: ["oj.f", "Orange Juice Futures", "agriculture", "US cents per pound"],
});

const FUNDS = Object.freeze({
  IVV: ["ivv.us", "iShares Core S&P 500 ETF", "equity", "US", "USD"],
  IWM: ["iwm.us", "iShares Russell 2000 ETF", "equity", "US", "USD"],
  IEFA: ["iefa.us", "iShares Core MSCI EAFE ETF", "equity", "Global", "USD"],
  EEM: [
    "eem.us",
    "iShares MSCI Emerging Markets ETF",
    "equity",
    "Emerging Markets",
    "USD",
  ],
  ACWI: ["acwi.us", "iShares MSCI ACWI ETF", "equity", "Global", "USD"],
  MCHI: ["mchi.us", "iShares MSCI China ETF", "equity", "China", "USD"],
  TLT: [
    "tlt.us",
    "iShares 20+ Year Treasury Bond ETF",
    "fixed_income",
    "US",
    "USD",
  ],
  IEF: [
    "ief.us",
    "iShares 7-10 Year Treasury Bond ETF",
    "fixed_income",
    "US",
    "USD",
  ],
  SHY: [
    "shy.us",
    "iShares 1-3 Year Treasury Bond ETF",
    "fixed_income",
    "US",
    "USD",
  ],
  LQD: [
    "lqd.us",
    "iShares iBoxx Investment Grade Corporate Bond ETF",
    "fixed_income",
    "US",
    "USD",
  ],
  HYG: [
    "hyg.us",
    "iShares iBoxx High Yield Corporate Bond ETF",
    "fixed_income",
    "US",
    "USD",
  ],
  AGG: [
    "agg.us",
    "iShares Core U.S. Aggregate Bond ETF",
    "fixed_income",
    "US",
    "USD",
  ],
  IAU: ["iau.us", "iShares Gold Trust", "commodity", "Global", "USD"],
  SLV: ["slv.us", "iShares Silver Trust", "commodity", "Global", "USD"],
  IBIT: ["ibit.us", "iShares Bitcoin Trust ETF", "digital_asset", "US", "USD"],
  ETHA: ["etha.us", "iShares Ethereum Trust ETF", "digital_asset", "US", "USD"],
});

function parseStooqCsv(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length)
    throw new MarketDataError(
      "provider_invalid_response",
      "Stooq returned no data."
    );
  const row =
    lines.length > 1 && /symbol/i.test(lines[0]) ? lines[1] : lines[0];
  const values = row.split(",");
  if (values.length < 8 || values.some((value) => /^N\/D$/i.test(value.trim())))
    throw new MarketDataError("quote_not_found", "Stooq quote is unavailable.");
  const open = numeric(values[3]);
  const high = numeric(values[4]);
  const low = numeric(values[5]);
  const close = numeric(values[6]);
  if ([open, high, low, close].some((value) => value === null))
    throw new MarketDataError(
      "provider_invalid_response",
      "Stooq quote is malformed."
    );
  const change = close - open;
  return {
    date: values[1] || null,
    time: values[2] || null,
    open: decimal(open),
    high: decimal(high),
    low: decimal(low),
    price: decimal(close),
    volume: numeric(values[7]) === null ? null : decimal(numeric(values[7])),
    change: decimal(change),
    change_percent: open === 0 ? null : decimal((change / open) * 100),
  };
}

async function stooqQuote(symbol, dependencies = {}) {
  const params = new URLSearchParams({ s: symbol, i: "d" });
  const text = await fetchText(
    `${STOOQ_BASE_URL}?${params.toString()}`,
    { headers: { Accept: "text/csv", "User-Agent": "Athena/1.0" } },
    dependencies.fetchImpl
  );
  return parseStooqCsv(text);
}

function commonQuote(tool, inputSymbol, mapped, quote, extra = {}) {
  return {
    tool,
    ok: true,
    input_symbol: inputSymbol,
    mapped_symbol: mapped,
    ...extra,
    ...quote,
    provider: "stooq",
    source: "stooq_csv",
    freshness: "delayed_minutes",
    cache_hit: false,
    note: "Free market data may be delayed and is for research reference only.",
    timestamp: new Date().toISOString(),
  };
}

async function executeGlobalIndexQuote(input, dependencies = {}) {
  const symbol = requiredString(input, "symbol").toUpperCase();
  const mapping = INDEXES[symbol] || [
    symbol.toLowerCase(),
    "Custom Index",
    "UNKNOWN",
    "UNKNOWN",
    "UNKNOWN",
  ];
  try {
    const quote = await stooqQuote(mapping[0], dependencies);
    return commonQuote("global_index_quote", symbol, mapping[0], quote, {
      name: mapping[1],
      market: mapping[2],
      region: mapping[3],
      currency: mapping[4],
    });
  } catch (stooqError) {
    const juheSymbol = JUHE_US_INDEX_FALLBACKS[symbol];
    if (!juheSymbol) throw stooqError;
    const quote = await executeGlobalStockQuote(
      { market: "us", symbol: juheSymbol },
      dependencies
    );
    return {
      tool: "global_index_quote",
      ok: true,
      input_symbol: symbol,
      mapped_symbol: mapping[0],
      name: quote.name || mapping[1],
      market: mapping[2],
      region: mapping[3],
      currency: mapping[4],
      price: quote.price,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      previous_close: quote.previous_close,
      change: quote.change,
      change_percent: quote.change_percent,
      volume: quote.volume,
      date: quote.date,
      time: quote.time,
      provider: "juhe",
      source: "juhe_stock_usa_index_fallback",
      freshness: "delayed_reference",
      cache_hit: false,
      note: "Index data may be delayed and is for research reference only.",
      timestamp: new Date().toISOString(),
    };
  }
}

function parseProviderNumber(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).replace(/[$,%\s]/g, "");
  return numeric(normalized) === null ? null : decimal(Number(normalized));
}

async function preciousMetalFallback(mapping, dependencies = {}) {
  const symbol = mapping[0] === "gc.f" ? "XAU" : "XAG";
  const body = await fetchJson(
    `${GOLD_API_BASE_URL}/${symbol}`,
    { headers: { Accept: "application/json", "User-Agent": "Athena/1.0" } },
    dependencies.fetchImpl
  );
  if (body?.symbol !== symbol || numeric(body?.price) === null)
    throw new MarketDataError(
      "provider_invalid_response",
      "Precious metal quote is unavailable."
    );
  return {
    price: decimal(Number(body.price)),
    date: body.updatedAt || null,
    provider: "gold-api",
    source: "gold_api_public_price_fallback",
  };
}

async function executeGlobalCommodityQuote(input, dependencies = {}) {
  const symbol = requiredString(input, "symbol").toUpperCase();
  const mapping = COMMODITIES[symbol] || [
    symbol.toLowerCase(),
    "Custom Commodity",
    "unknown",
    "unknown",
  ];
  try {
    const quote = await stooqQuote(mapping[0], dependencies);
    return commonQuote("global_commodity_quote", symbol, mapping[0], quote, {
      name: mapping[1],
      category: mapping[2],
      unit_hint: mapping[3],
      currency: "USD",
    });
  } catch (stooqError) {
    if (!["gc.f", "si.f"].includes(mapping[0])) throw stooqError;
    const quote = await preciousMetalFallback(mapping, dependencies);
    return {
      tool: "global_commodity_quote",
      ok: true,
      input_symbol: symbol,
      mapped_symbol: mapping[0],
      name: mapping[1],
      category: mapping[2],
      unit_hint: mapping[3],
      currency: "USD",
      price: quote.price,
      open: null,
      high: null,
      low: null,
      change: null,
      change_percent: null,
      volume: null,
      date: quote.date,
      time: null,
      provider: quote.provider,
      source: quote.source,
      freshness: "near_realtime_reference",
      cache_hit: false,
      note: "Public precious metal data is for research reference only.",
      timestamp: new Date().toISOString(),
    };
  }
}

async function nasdaqFundFallback(symbol, dependencies = {}) {
  const body = await fetchJson(
    `${NASDAQ_QUOTE_BASE_URL}/${encodeURIComponent(symbol)}/info?assetclass=etf`,
    {
      headers: {
        Accept: "application/json, text/plain, */*",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Athena/1.0",
      },
    },
    dependencies.fetchImpl
  );
  const data = body?.data;
  const quote = data?.primaryData;
  if (!data || !quote || parseProviderNumber(quote.lastSalePrice) === null)
    throw new MarketDataError(
      "provider_invalid_response",
      "Nasdaq fund quote is unavailable."
    );
  return {
    name: data.companyName || null,
    price: parseProviderNumber(quote.lastSalePrice),
    change: parseProviderNumber(quote.netChange),
    change_percent: parseProviderNumber(quote.percentageChange),
    volume: parseProviderNumber(quote.volume),
    date: quote.lastTradeTimestamp || null,
  };
}

async function executeGlobalFundQuote(input, dependencies = {}) {
  const symbol = requiredString(input, "symbol").toUpperCase();
  const mapping = FUNDS[symbol] || [
    `${symbol.toLowerCase()}.us`,
    "Custom US-listed Fund/ETF",
    "unknown",
    "US",
    "USD",
  ];
  try {
    const quote = await stooqQuote(mapping[0], dependencies);
    return commonQuote("global_fund_quote", symbol, mapping[0], quote, {
      name: mapping[1],
      asset_class: mapping[2],
      region: mapping[3],
      currency: mapping[4],
      quote_type: "market_price",
    });
  } catch {
    const quote = await nasdaqFundFallback(symbol, dependencies);
    return {
      tool: "global_fund_quote",
      ok: true,
      input_symbol: symbol,
      mapped_symbol: mapping[0],
      name: quote.name || mapping[1],
      asset_class: mapping[2],
      region: mapping[3],
      currency: mapping[4],
      quote_type: "market_price",
      price: quote.price,
      open: null,
      high: null,
      low: null,
      change: quote.change,
      change_percent: quote.change_percent,
      volume: quote.volume,
      date: quote.date,
      time: null,
      provider: "nasdaq",
      source: "nasdaq_public_etf_quote_fallback",
      freshness: "delayed_reference",
      cache_hit: false,
      note: "ETF market data may be delayed and is for research reference only.",
      timestamp: new Date().toISOString(),
    };
  }
}

function normalizeCnSymbol(symbol) {
  const lower = symbol.toLowerCase();
  if (/^(sh|sz)\d{6}$/.test(lower)) return lower;
  if (!/^\d{6}$/.test(lower))
    throw new MarketDataError(
      "invalid_input",
      "Invalid mainland stock symbol."
    );
  return `${lower.startsWith("6") ? "sh" : "sz"}${lower}`;
}

function normalizeHkSymbol(symbol) {
  const digits = symbol.replace(/^hk/i, "");
  if (!/^\d{1,5}$/.test(digits))
    throw new MarketDataError(
      "invalid_input",
      "Invalid Hong Kong stock symbol."
    );
  return digits.padStart(5, "0");
}

function assertJuhe(body, scope) {
  const code = Number(body?.error_code || 0);
  if (code !== 0)
    throw new MarketDataError(
      code === 10012 ? "provider_daily_limit" : "provider_response_error",
      `Juhe ${scope} request failed.`,
      { providerCode: code }
    );
}

async function executeGlobalStockQuote(input, dependencies = {}) {
  const market = requiredString(input, "market").toLowerCase();
  const symbol = requiredString(input, "symbol").toUpperCase();
  const apiKey = dependencies.apiKey || readManagedSecret("juheStock");
  let path;
  let code;
  let queryKey;
  if (market === "cn") {
    path = "hs";
    code = normalizeCnSymbol(symbol);
    queryKey = "gid";
  } else if (market === "hk") {
    path = "hk";
    code = normalizeHkSymbol(symbol);
    queryKey = "num";
  } else if (market === "us") {
    if (!/^[A-Z0-9.-]{1,16}$/.test(symbol))
      throw new MarketDataError("invalid_input", "Invalid US stock symbol.");
    path = "usa";
    code = symbol;
    queryKey = "gid";
  } else {
    throw new MarketDataError("invalid_input", "Unsupported stock market.");
  }
  const query = new URLSearchParams({ [queryKey]: code, key: apiKey });
  const body = await fetchJson(
    `${JUHE_STOCK_BASE_URL}/${path}?${query.toString()}`,
    { headers: { Accept: "application/json", "User-Agent": "Athena/1.0" } },
    dependencies.fetchImpl
  );
  assertJuhe(body, "stock");
  const stock = body?.result?.[0]?.data;
  if (!stock)
    throw new MarketDataError("quote_not_found", "Stock quote was not found.");
  const fields =
    market === "cn"
      ? {
          price: stock.nowPri,
          open: stock.todayStartPri,
          previous_close: stock.yestodEndPri,
          high: stock.todayMax,
          low: stock.todayMin,
          change: stock.increase,
          change_percent: stock.increPer,
        }
      : {
          price: stock.lastestpri,
          open: stock.openpri,
          previous_close: stock.formpri,
          high: stock.maxpri,
          low: stock.minpri,
          change: stock.limit,
          change_percent: stock.uppic,
        };
  return {
    tool: "global_stock_quote",
    ok: true,
    market,
    symbol: code,
    name: stock.name || null,
    ...fields,
    volume: stock.traNumber || null,
    turnover: stock.traAmount || null,
    date: stock.date || null,
    time: stock.time || null,
    provider: "juhe",
    source: `juhe_stock_${path}`,
    freshness: "delayed_reference",
    cache_hit: false,
    note: "Stock data may be delayed and is for research reference only.",
    timestamp: new Date().toISOString(),
  };
}

async function frankfurter(base, quote, dependencies = {}) {
  const query = new URLSearchParams({ base, symbols: quote });
  const body = await fetchJson(
    `${FRANKFURTER_URL}?${query.toString()}`,
    { headers: { Accept: "application/json" } },
    dependencies.fetchImpl
  );
  const rate = body?.rates?.[quote];
  if (!Number.isFinite(Number(rate)))
    throw new MarketDataError(
      "quote_not_found",
      "Exchange rate was not found."
    );
  return { rate: String(rate), date: body.date || null };
}

async function juheForex(base, quote, dependencies = {}) {
  const apiKey = dependencies.apiKey || readManagedSecret("juheForex");
  const query = new URLSearchParams({
    key: apiKey,
    from: base,
    to: quote,
    version: "2",
  });
  const body = await fetchJson(
    `${JUHE_FOREX_URL}?${query.toString()}`,
    { headers: { Accept: "application/json" } },
    dependencies.fetchImpl
  );
  assertJuhe(body, "forex");
  const row = body?.result?.[0];
  const rate = row?.exchange ?? row?.result;
  if (rate === undefined || rate === null)
    throw new MarketDataError(
      "quote_not_found",
      "Exchange rate was not found."
    );
  return { rate: String(rate), date: row.updateTime || null };
}

async function executeGlobalForexRate(input, dependencies = {}) {
  const base = requiredString(input, "base").toUpperCase();
  const quote = requiredString(input, "quote").toUpperCase();
  const provider = optionalString(input, "provider", "auto").toLowerCase();
  if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote))
    throw new MarketDataError("invalid_input", "Invalid currency code.");
  if (base === quote)
    return {
      tool: "global_forex_rate",
      ok: true,
      base,
      quote,
      rate: "1",
      provider: "local_identity",
      source: "local_identity",
      freshness: "instant",
      cache_hit: false,
      timestamp: new Date().toISOString(),
    };
  let result;
  let source;
  let fallbackFrom = null;
  if (provider === "juhe") {
    result = await juheForex(base, quote, dependencies);
    source = "juhe_exchange_currency";
  } else if (provider === "frankfurter") {
    result = await frankfurter(base, quote, dependencies);
    source = "frankfurter";
  } else if (provider === "auto") {
    try {
      result = await juheForex(base, quote, dependencies);
      source = "juhe_exchange_currency";
    } catch {
      result = await frankfurter(base, quote, dependencies);
      source = "frankfurter";
      fallbackFrom = "juhe";
    }
  } else {
    throw new MarketDataError("invalid_input", "Unsupported forex provider.");
  }
  return {
    tool: "global_forex_rate",
    ok: true,
    base,
    quote,
    rate: result.rate,
    date: result.date,
    provider: source === "frankfurter" ? "frankfurter" : "juhe",
    requested_provider: provider,
    source,
    freshness: source === "frankfurter" ? "daily_reference" : "near_realtime",
    fallback_from: fallbackFrom,
    cache_hit: false,
    note: "Exchange rates are for research reference only.",
    timestamp: new Date().toISOString(),
  };
}

const symbolParameters = (description) => ({
  type: "object",
  properties: { symbol: { type: "string", description } },
  required: ["symbol"],
  additionalProperties: false,
});

const globalForexRate = jsonTool({
  name: "global_forex_rate",
  description:
    "Query global foreign exchange rates. Auto mode uses Juhe first and falls back to Frankfurter daily reference data.",
  examples: [
    {
      prompt: "美元兑人民币汇率",
      call: JSON.stringify({ base: "USD", quote: "CNY" }),
    },
  ],
  parameters: {
    type: "object",
    properties: {
      base: { type: "string", description: "Base ISO currency code." },
      quote: { type: "string", description: "Quote ISO currency code." },
      provider: { type: "string", enum: ["auto", "juhe", "frankfurter"] },
    },
    required: ["base", "quote"],
    additionalProperties: false,
  },
  execute: executeGlobalForexRate,
});

const globalIndexQuote = jsonTool({
  name: "global_index_quote",
  description:
    "Query delayed quotes for major global market indexes such as S&P 500, Nasdaq, Dow, Hang Seng, Shanghai Composite, Nikkei, FTSE, and DAX.",
  parameters: symbolParameters(
    "Index name or code, for example SP500, HSI, SSE, or DAX."
  ),
  execute: executeGlobalIndexQuote,
});

const globalStockQuote = jsonTool({
  name: "global_stock_quote",
  description:
    "Query delayed individual stock quotes for mainland China, Hong Kong, or US markets using Juhe.",
  parameters: {
    type: "object",
    properties: {
      market: { type: "string", enum: ["cn", "hk", "us"] },
      symbol: {
        type: "string",
        description: "Stock code, for example sh601009, 00700, or AAPL.",
      },
    },
    required: ["market", "symbol"],
    additionalProperties: false,
  },
  execute: executeGlobalStockQuote,
});

const globalCommodityQuote = jsonTool({
  name: "global_commodity_quote",
  description:
    "Query delayed global commodity and precious metal quotes such as WTI, Brent, gold, silver, copper, natural gas, and agricultural futures.",
  parameters: symbolParameters(
    "Commodity name or code, for example GOLD, WTI, COPPER, or 黄金."
  ),
  execute: executeGlobalCommodityQuote,
});

const globalFundQuote = jsonTool({
  name: "global_fund_quote",
  description:
    "Query delayed market prices for major US-listed funds and ETFs including IVV, IWM, TLT, AGG, IBIT, ETHA, IAU, and SLV. This is market price, not NAV.",
  parameters: symbolParameters(
    "Fund or ETF ticker, for example IVV, TLT, IBIT, or IAU."
  ),
  execute: executeGlobalFundQuote,
});

const globalMarketAgent = {
  name: "global-market-agent",
  startupConfig: { params: {} },
  plugin: [
    globalForexRate,
    globalIndexQuote,
    globalStockQuote,
    globalCommodityQuote,
    globalFundQuote,
  ],
};

module.exports = {
  executeGlobalCommodityQuote,
  executeGlobalForexRate,
  executeGlobalFundQuote,
  executeGlobalIndexQuote,
  executeGlobalStockQuote,
  globalMarketAgent,
  normalizeCnSymbol,
  normalizeHkSymbol,
  parseStooqCsv,
};
