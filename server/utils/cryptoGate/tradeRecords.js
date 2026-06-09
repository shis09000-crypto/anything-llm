const { GateRestClient } = require("./restClient");
const { getGateCredentials } = require("./secretProvider");
const { safeErrorMessage } = require("./sanitizer");
const { cryptoGateWsManager } = require("./wsClient");
const { normalizePosition } = require("./openFuturesPositions");
const {
  SystemSettingsTradeCycleMemoryStore,
  buildTradeCycles,
} = require("./tradeRecordCycles");

const DEFAULT_WINDOW_DAYS = 30;
const MAX_BATCH_LIMIT = 50;
const DEFAULT_BATCH_LIMIT = 50;
const DEFAULT_SETTLE = "usdt";
const STABLE_FEE_ASSETS = new Set(["USD", "USDT", "USDC", "GUSD", "DAI"]);

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.result)) return value.result;
  if (Array.isArray(value?.trades)) return value.trades;
  if (isRecord(value)) return [value];
  return [];
}

function numberValue(value, fallback = 0) {
  const number = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(number) ? number : fallback;
}

function decimalString(value, digits = 2) {
  return numberValue(value).toFixed(digits);
}

function trimDecimal(value, digits = 8) {
  const number = numberValue(value);
  if (!number) return "0";
  return number
    .toFixed(digits)
    .replace(/\.?0+$/, "")
    .replace(/\.$/, "");
}

function rawAmountString(value) {
  const text = String(value ?? "").trim();
  return text || "0";
}

function sumDecimalStrings(values, digits = 8) {
  return trimDecimal(
    values.reduce((sum, value) => sum + Math.abs(numberValue(value)), 0),
    digits
  );
}

function sameValue(records, selector) {
  if (!records.length) return null;
  const first = selector(records[0]);
  return records.every((record) => selector(record) === first) ? first : null;
}

function positiveAmount(value) {
  return Math.abs(numberValue(value));
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function normalizeContract(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/-/g, "_");
}

function compactSymbol(contract) {
  return normalizeContract(contract).replace(/_/g, "");
}

function splitPair(value) {
  const normalized = normalizeContract(value);
  const [baseAsset, quoteAsset] = normalized.split("_");
  return {
    baseAsset: baseAsset || normalized || "ASSET",
    quoteAsset: quoteAsset || "USDT",
    normalized,
  };
}

function tickerMapByPair(tickers = []) {
  const map = new Map();
  if (!Array.isArray(tickers)) return map;
  for (const ticker of tickers) {
    const pair = normalizeContract(ticker?.currency_pair);
    const price = numberValue(firstPresent(ticker, ["last", "close"]), 0);
    if (pair && price > 0) map.set(pair, price);
  }
  return map;
}

function firstPresent(source, keys, fallback = null) {
  for (const key of keys) {
    if (source?.[key] !== undefined && source?.[key] !== null) {
      return source[key];
    }
  }
  return fallback;
}

function pushPartialFailure(partialFailures, failure) {
  const key = `${failure.source}:${failure.message}`;
  if (
    partialFailures.some((item) => `${item.source}:${item.message}` === key)
  ) {
    return;
  }
  partialFailures.push(failure);
}

function booleanValue(value) {
  if (value === true) return true;
  if (value === false) return false;
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["true", "1", "yes"].includes(normalized);
}

function firstPositiveNumber(source, keys, fallback = 0) {
  for (const key of keys) {
    const value = Math.abs(numberValue(source?.[key], NaN));
    if (Number.isFinite(value) && value > 0) return value;
  }
  return fallback;
}

function tradeTimestampMs(trade) {
  const raw = firstPresent(trade, [
    "create_time_ms",
    "time_ms",
    "createTimeMs",
    "create_time",
    "time",
  ]);
  const number = numberValue(raw, 0);
  if (!number) return 0;
  return number > 1_000_000_000_000
    ? Math.floor(number)
    : Math.floor(number * 1000);
}

function normalizeWindow({ from, to, cursorTs }) {
  const nowSec = Math.floor(Date.now() / 1000);
  const defaultFrom = nowSec - DEFAULT_WINDOW_DAYS * 24 * 60 * 60;
  const fromSec = clampInteger(from, defaultFrom, 0, nowSec);
  const rawToSec = clampInteger(to, nowSec, fromSec, nowSec);
  const cursorSec = cursorTs
    ? Math.floor(
        clampInteger(cursorTs, rawToSec * 1000, 0, rawToSec * 1000) / 1000
      )
    : null;
  const toSec = cursorSec
    ? Math.max(fromSec, Math.min(rawToSec, cursorSec))
    : rawToSec;
  return { fromSec, toSec, requestedToSec: rawToSec };
}

function spotAction(side) {
  return String(side || "").toLowerCase() === "sell" ? "spot_sell" : "spot_buy";
}

function assetToUsdRate(asset, tickerPrices = new Map()) {
  const normalized = normalizeContract(asset);
  if (STABLE_FEE_ASSETS.has(normalized)) return 1;
  return numberValue(tickerPrices.get(`${normalized}_USDT`), 0);
}

function spotFeeUsd({
  fee,
  feeCurrency,
  baseAsset,
  quoteAsset,
  price,
  tickerPrices,
}) {
  const feeAmount = Math.abs(numberValue(fee));
  if (feeAmount <= 0) return { feeUsd: 0, missingRate: false };

  const normalizedFeeCurrency = normalizeContract(feeCurrency || quoteAsset);
  const normalizedBase = normalizeContract(baseAsset);
  const normalizedQuote = normalizeContract(quoteAsset);
  const tradePrice = numberValue(price);

  if (STABLE_FEE_ASSETS.has(normalizedFeeCurrency)) {
    return { feeUsd: feeAmount, missingRate: false };
  }

  if (normalizedFeeCurrency === normalizedBase && tradePrice > 0) {
    const quoteRate = assetToUsdRate(normalizedQuote, tickerPrices);
    if (quoteRate > 0) {
      return { feeUsd: feeAmount * tradePrice * quoteRate, missingRate: false };
    }
  }

  if (normalizedFeeCurrency === normalizedQuote) {
    const quoteRate = assetToUsdRate(normalizedQuote, tickerPrices);
    if (quoteRate > 0) {
      return { feeUsd: feeAmount * quoteRate, missingRate: false };
    }
  }

  const feeRate = assetToUsdRate(normalizedFeeCurrency, tickerPrices);
  if (feeRate > 0) return { feeUsd: feeAmount * feeRate, missingRate: false };

  return { feeUsd: 0, missingRate: true };
}

function feeDebugFields(raw) {
  return {
    currency_pair: firstPresent(raw, ["currency_pair", "symbol"], null),
    order_id: firstPresent(raw, ["order_id", "orderId"], null),
    fee: firstPresent(raw, ["fee"], null),
    fee_currency: firstPresent(raw, ["fee_currency", "feeCurrency"], null),
    point_fee: firstPresent(raw, ["point_fee", "pointFee"], null),
    gt_fee: firstPresent(raw, ["gt_fee", "gtFee"], null),
  };
}

function spotFeeNeedsTicker(raw) {
  if (!isRecord(raw)) return false;
  const gtFee = positiveAmount(firstPresent(raw, ["gt_fee", "gtFee"], "0"));
  if (gtFee > 0) return true;
  const feeAmount = positiveAmount(firstPresent(raw, ["fee"], "0"));
  if (feeAmount <= 0) return false;

  const pair = splitPair(
    firstPresent(raw, ["currency_pair", "symbol"], "UNKNOWN_USDT")
  );
  const feeCurrency = normalizeContract(
    firstPresent(raw, ["fee_currency", "feeCurrency"], pair.quoteAsset)
  );
  if (!feeCurrency || STABLE_FEE_ASSETS.has(feeCurrency)) return false;
  if (
    feeCurrency === pair.baseAsset &&
    STABLE_FEE_ASSETS.has(pair.quoteAsset)
  ) {
    return false;
  }
  return true;
}

function spotFeeDetails({
  fee,
  feeCurrency,
  pointFee,
  gtFee,
  baseAsset,
  quoteAsset,
  price,
  tickerPrices,
  partialFailures,
}) {
  const feeAmount = positiveAmount(fee);
  const pointFeeAmount = positiveAmount(pointFee);
  const gtFeeAmount = positiveAmount(gtFee);

  if (feeAmount > 0) {
    const feeConversion = spotFeeUsd({
      fee,
      feeCurrency,
      baseAsset,
      quoteAsset,
      price,
      tickerPrices,
    });
    if (feeConversion.missingRate) {
      partialFailures.push({
        source: "spot_fee_conversion",
        message: `手续费折算缺价格：${feeCurrency}_USDT`,
      });
    }
    return {
      feeUsd: feeConversion.feeUsd,
      feeSource: "asset",
      feeDisplayAmount: rawAmountString(fee),
      feeDisplayCurrency: feeCurrency,
    };
  }

  if (pointFeeAmount > 0) {
    return {
      feeUsd: 0,
      feeSource: "point",
      feeDisplayAmount: rawAmountString(pointFee),
      feeDisplayCurrency: "点卡抵扣",
    };
  }

  if (gtFeeAmount > 0) {
    const gtRate = assetToUsdRate("GT", tickerPrices);
    if (gtRate <= 0) {
      partialFailures.push({
        source: "spot_fee_conversion",
        message: "手续费折算缺价格：GT_USDT",
      });
    }
    return {
      feeUsd: gtRate > 0 ? gtFeeAmount * gtRate : 0,
      feeSource: "gt",
      feeDisplayAmount: rawAmountString(gtFee),
      feeDisplayCurrency: "GT",
    };
  }

  return {
    feeUsd: 0,
    feeSource: "zero",
    feeDisplayAmount: rawAmountString(fee),
    feeDisplayCurrency: feeCurrency,
  };
}

function futuresAction(raw, orderDetails = null) {
  const explicit = String(
    firstPresent(raw, ["action", "action_type", "finish_as"], "")
  ).toLowerCase();
  if (explicit.includes("close_long")) return "futures_close_long";
  if (explicit.includes("close_short")) return "futures_close_short";
  if (explicit.includes("open_long")) return "futures_open_long";
  if (explicit.includes("open_short")) return "futures_open_short";

  const signedSize = numberValue(firstPresent(raw, ["size", "order_size"]), 0);
  const closeSize = numberValue(
    firstPresent(raw, ["close_size", "closeSize"]),
    0
  );
  if (closeSize > 0 && signedSize > 0) return "futures_close_short";
  if (closeSize < 0 && signedSize < 0) return "futures_close_long";

  const autoSize = String(
    firstPresent(orderDetails, ["auto_size", "autoSize"], "")
  ).toLowerCase();
  if (autoSize === "close_short") return "futures_close_short";
  if (autoSize === "close_long") return "futures_close_long";

  const side = String(
    firstPresent(
      raw,
      ["side", "order_side"],
      firstPresent(orderDetails, ["side"], "")
    )
  ).toLowerCase();
  const reduceOnly =
    booleanValue(
      firstPresent(raw, ["reduce_only", "is_reduce_only", "is_close", "close"])
    ) ||
    booleanValue(
      firstPresent(orderDetails, [
        "reduce_only",
        "is_reduce_only",
        "is_close",
        "close",
      ])
    ) ||
    firstPositiveNumber(raw, ["close_size", "closeSize"]) > 0 ||
    firstPositiveNumber(orderDetails || {}, ["close_size", "closeSize"]) > 0;

  if (reduceOnly) {
    if (side === "buy" || signedSize > 0) return "futures_close_short";
    return "futures_close_long";
  }
  if (side === "sell" || signedSize < 0) return "futures_open_short";
  return "futures_open_long";
}

function futuresContractMultiplier(contractDetails) {
  const multiplier = firstPositiveNumber(contractDetails || {}, [
    "quanto_multiplier",
    "multiplier",
    "contract_size",
    "contractSize",
  ]);
  return multiplier > 0 ? multiplier : null;
}

function futuresContractKey(raw) {
  return normalizeContract(
    firstPresent(raw, ["contract", "currency_pair", "symbol"], "")
  );
}

function futuresOrderKey(raw) {
  const orderId = String(
    firstPresent(raw, ["order_id", "orderId"], "") || ""
  ).trim();
  const contract = futuresContractKey(raw);
  if (!orderId || !contract || orderId === "--") return "";
  return `${contract}:${orderId}`;
}

function futuresContractKeyForRecord(record) {
  const base = normalizeContract(record?.baseAsset);
  const quote = normalizeContract(record?.quoteAsset || DEFAULT_SETTLE);
  if (!base || !quote) return normalizeContract(record?.symbol);
  return `${base}_${quote}`;
}

function isFuturesCloseAction(action) {
  return action === "futures_close_long" || action === "futures_close_short";
}

function positionSideForCloseAction(action) {
  if (action === "futures_close_long") return "long";
  if (action === "futures_close_short") return "short";
  return null;
}

function normalizePositionClose(raw, index = 0) {
  if (!isRecord(raw)) return null;
  const contract = normalizeContract(
    firstPresent(raw, ["contract", "symbol"], "")
  );
  const side = String(firstPresent(raw, ["side"], "")).toLowerCase();
  const rawTime = firstPresent(
    raw,
    ["time", "close_time", "create_time"],
    null
  );
  const time = numberValue(rawTime, 0);
  const ts =
    time > 1_000_000_000_000 ? Math.floor(time) : Math.floor(time * 1000);
  const pnl = firstPresent(raw, ["pnl", "realized_pnl", "realised_pnl"], null);
  if (!contract || !["long", "short"].includes(side) || !ts || pnl === null) {
    return null;
  }

  const openPrice =
    side === "long"
      ? firstPresent(raw, ["long_price", "open_price", "entry_price"], "0")
      : firstPresent(raw, ["short_price", "open_price", "entry_price"], "0");
  const closePrice =
    side === "long"
      ? firstPresent(raw, ["short_price", "close_price", "exit_price"], "0")
      : firstPresent(raw, ["long_price", "close_price", "exit_price"], "0");

  return {
    index,
    raw,
    contract,
    symbol: compactSymbol(contract),
    side,
    action: side === "long" ? "futures_close_long" : "futures_close_short",
    ts,
    pnl: numberValue(pnl),
    openPrice: numberValue(openPrice),
    closePrice: numberValue(closePrice),
  };
}

function normalizeSpotTrade(
  raw,
  { tickerPrices = new Map(), partialFailures = [] } = {}
) {
  if (!isRecord(raw)) return null;
  const pair = splitPair(
    firstPresent(raw, ["currency_pair", "symbol"], "UNKNOWN_USDT")
  );
  const ts = tradeTimestampMs(raw);
  if (!ts) return null;
  const quantity = firstPresent(raw, ["amount", "quantity", "size"], "0");
  const price = firstPresent(raw, ["price"], "0");
  const fee = firstPresent(raw, ["fee"], "0");
  const pointFee = firstPresent(raw, ["point_fee", "pointFee"], "0");
  const gtFee = firstPresent(raw, ["gt_fee", "gtFee"], "0");
  const feeCurrency = normalizeContract(
    firstPresent(raw, ["fee_currency", "feeCurrency"], pair.quoteAsset)
  );
  const feeDetails = spotFeeDetails({
    fee,
    feeCurrency,
    pointFee,
    gtFee,
    baseAsset: pair.baseAsset,
    quoteAsset: pair.quoteAsset,
    price,
    tickerPrices,
    partialFailures,
  });
  const notional = numberValue(quantity) * numberValue(price);

  return {
    id: `spot:${firstPresent(raw, ["id", "trade_id"], `${ts}:${pair.normalized}`)}`,
    ts,
    marketType: "spot",
    symbol: compactSymbol(pair.normalized),
    baseAsset: pair.baseAsset,
    quoteAsset: pair.quoteAsset,
    contractType: "spot",
    action: spotAction(raw.side),
    quantity: trimDecimal(quantity, 8),
    price: trimDecimal(price, 8),
    notionalUsd: decimalString(
      firstPresent(raw, ["notional_usd"], notional),
      2
    ),
    feeUsd: decimalString(feeDetails.feeUsd, 4),
    feeAmount: rawAmountString(fee),
    feeCurrency,
    feeSource: feeDetails.feeSource,
    pointFeeAmount: rawAmountString(pointFee),
    gtFeeAmount: rawAmountString(gtFee),
    feeDisplayAmount: feeDetails.feeDisplayAmount,
    feeDisplayCurrency: feeDetails.feeDisplayCurrency,
    realizedPnlUsd: null,
    realizedPnlPct: null,
    realizedPnlSource: null,
    orderId: String(firstPresent(raw, ["order_id", "orderId"], "--")),
    iconUrl: `/crypto-icons/${pair.baseAsset.toLowerCase()}.png`,
  };
}

function normalizeFuturesTrade(
  raw,
  {
    contractDetails = new Map(),
    orderDetails = new Map(),
    partialFailures = [],
  } = {}
) {
  if (!isRecord(raw)) return null;
  const pair = splitPair(
    firstPresent(raw, ["contract", "currency_pair", "symbol"], "UNKNOWN_USDT")
  );
  const ts = tradeTimestampMs(raw);
  if (!ts) return null;
  const rawQuantity = firstPresent(
    raw,
    ["size", "order_size", "amount", "quantity"],
    "0"
  );
  const contractQuantity = Math.abs(numberValue(rawQuantity));
  const details = contractDetails.get(pair.normalized);
  const multiplier = futuresContractMultiplier(details);
  if (!multiplier) {
    pushPartialFailure(partialFailures, {
      source: "futures_contract_metadata",
      message: `合约乘数缺失：${pair.normalized}`,
    });
  }
  const quantity = contractQuantity * (multiplier || 1);
  const price = firstPresent(raw, ["price"], "0");
  const rawFee = firstPresent(raw, ["fee"], "0");
  const fee = Math.abs(numberValue(rawFee));
  const feeCurrency = normalizeContract(
    firstPresent(raw, ["fee_currency", "feeCurrency", "settle"], "USDT")
  );
  const computedNotional = Math.abs(quantity * numberValue(price));
  const notional = firstPositiveNumber(
    raw,
    ["notional_usd", "trade_value", "order_value", "value"],
    computedNotional
  );
  const pnl = firstPresent(raw, ["pnl", "realised_pnl", "realized_pnl"], null);
  const order = orderDetails.get(futuresOrderKey(raw)) || null;

  return {
    id: `futures:${firstPresent(raw, ["id", "trade_id"], `${ts}:${pair.normalized}`)}`,
    ts,
    marketType: "futures",
    symbol: compactSymbol(pair.normalized),
    baseAsset: pair.baseAsset,
    quoteAsset: pair.quoteAsset,
    contractType: "perpetual",
    action: futuresAction(raw, order),
    quantity: trimDecimal(quantity, 8),
    price: trimDecimal(price, 8),
    notionalUsd: decimalString(notional, 2),
    feeUsd: decimalString(fee, 4),
    feeAmount: rawAmountString(rawFee),
    feeCurrency,
    feeSource: fee > 0 ? "asset" : "zero",
    pointFeeAmount: "0",
    gtFeeAmount: "0",
    feeDisplayAmount: rawAmountString(rawFee),
    feeDisplayCurrency: feeCurrency,
    realizedPnlUsd: pnl === null ? null : decimalString(pnl, 2),
    realizedPnlPct: null,
    realizedPnlSource: pnl === null ? null : "trade",
    orderId: String(firstPresent(raw, ["order_id", "orderId"], "--")),
    iconUrl: `/crypto-icons/${pair.baseAsset.toLowerCase()}.png`,
  };
}

function sortRecords(records) {
  return [...records].sort((left, right) => right.ts - left.ts);
}

function aggregateRecordKey(record) {
  const orderId = String(record.orderId || "").trim();
  if (!orderId || orderId === "--") {
    return `${record.marketType}:fill:${record.id}:${record.ts}`;
  }
  return [
    record.marketType,
    "order",
    orderId,
    record.symbol,
    record.action,
    record.contractType || "",
  ].join(":");
}

function aggregateRecordId(record) {
  const orderId = String(record.orderId || "").trim();
  if (!orderId || orderId === "--") return record.id;
  return aggregateRecordKey(record);
}

function aggregateFeeSource(records) {
  const source = sameValue(records, (record) => record.feeSource);
  return source || "unknown";
}

function aggregateFeeDisplay(records, feeSource) {
  const displayCurrency = sameValue(
    records,
    (record) => record.feeDisplayCurrency
  );
  if (feeSource === "unknown" || !displayCurrency) {
    return {
      feeDisplayAmount: "",
      feeDisplayCurrency: "多来源",
    };
  }

  return {
    feeDisplayAmount: sumDecimalStrings(
      records.map((record) => record.feeDisplayAmount),
      12
    ),
    feeDisplayCurrency: displayCurrency,
  };
}

function realizedPnlSourcePriority(source) {
  if (source === "position_close") return 3;
  if (source === "trade") return 2;
  if (source === "cycle_estimated") return 1;
  return 0;
}

function aggregateRealizedPnlSource(records) {
  return (
    records
      .map((record) => record.realizedPnlSource)
      .filter(Boolean)
      .sort(
        (left, right) =>
          realizedPnlSourcePriority(right) - realizedPnlSourcePriority(left)
      )[0] || null
  );
}

function aggregateRealizedPnlPct(records) {
  const values = records
    .map((record) => record.realizedPnlPct)
    .filter((value) => value !== null && value !== undefined);
  return values.length === 1 ? values[0] : null;
}

function aggregateOrderRecords(records) {
  const groups = new Map();
  for (const record of records) {
    const key = aggregateRecordKey(record);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  const aggregated = [];
  for (const group of groups.values()) {
    const sortedGroup = sortRecords(group);
    const latest = sortedGroup[0];
    const fillIds = Array.from(
      new Set(sortedGroup.flatMap((record) => record.fillIds || [record.id]))
    );
    const quantity = sortedGroup.reduce(
      (sum, record) => sum + Math.abs(numberValue(record.quantity)),
      0
    );
    const notional = sortedGroup.reduce(
      (sum, record) => sum + Math.abs(numberValue(record.notionalUsd)),
      0
    );
    const priceWeightedNotional = sortedGroup.reduce(
      (sum, record) =>
        sum +
        Math.abs(numberValue(record.quantity) * numberValue(record.price)),
      0
    );
    const feeUsd = sortedGroup.reduce(
      (sum, record) => sum + Math.abs(numberValue(record.feeUsd)),
      0
    );
    const realizedValues = sortedGroup
      .map((record) => record.realizedPnlUsd)
      .filter((value) => value !== null && value !== undefined);
    const realizedPnl =
      realizedValues.length > 0
        ? realizedValues.reduce((sum, value) => sum + numberValue(value), 0)
        : null;
    const feeSource = aggregateFeeSource(sortedGroup);
    const feeCurrency =
      sameValue(sortedGroup, (record) => record.feeCurrency) || "多来源";
    const { feeDisplayAmount, feeDisplayCurrency } = aggregateFeeDisplay(
      sortedGroup,
      feeSource
    );
    const weightedPrice =
      quantity > 0 && priceWeightedNotional > 0
        ? priceWeightedNotional / quantity
        : latest.price;

    aggregated.push({
      ...latest,
      id: aggregateRecordId(latest),
      ts: latest.ts,
      quantity: trimDecimal(quantity, 8),
      price: trimDecimal(weightedPrice, 8),
      notionalUsd: decimalString(notional, 2),
      feeUsd: decimalString(feeUsd, 4),
      feeAmount:
        feeCurrency === "多来源"
          ? "0"
          : sumDecimalStrings(
              sortedGroup.map((record) => record.feeAmount),
              12
            ),
      feeCurrency,
      feeSource,
      pointFeeAmount: sumDecimalStrings(
        sortedGroup.map((record) => record.pointFeeAmount || "0"),
        12
      ),
      gtFeeAmount: sumDecimalStrings(
        sortedGroup.map((record) => record.gtFeeAmount || "0"),
        12
      ),
      feeDisplayAmount,
      feeDisplayCurrency,
      realizedPnlUsd:
        realizedPnl === null ? null : decimalString(realizedPnl, 2),
      realizedPnlPct: aggregateRealizedPnlPct(sortedGroup),
      realizedPnlSource:
        realizedPnl === null ? null : aggregateRealizedPnlSource(sortedGroup),
      fillCount: fillIds.length || sortedGroup.length,
      fillIds,
      isAggregated: fillIds.length > 1 || sortedGroup.length > 1,
    });
  }

  return sortRecords(aggregated);
}

function dedupeRecords(records) {
  const seen = new Set();
  const result = [];
  for (const record of sortRecords(records)) {
    const key = `${record.marketType}:${record.id}:${record.orderId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(record);
  }
  return result;
}

function summarizeRecords(records) {
  const realizedRecords = records.filter(
    (record) => record.realizedPnlUsd !== null
  );
  const winningRecords = realizedRecords.filter(
    (record) => numberValue(record.realizedPnlUsd) > 0
  );
  const totalNotional = records.reduce(
    (sum, record) => sum + numberValue(record.notionalUsd),
    0
  );
  const totalFee = records.reduce(
    (sum, record) => sum + numberValue(record.feeUsd),
    0
  );
  const totalRealizedPnl = realizedRecords.reduce(
    (sum, record) => sum + numberValue(record.realizedPnlUsd),
    0
  );
  const spotNotional = records
    .filter((record) => record.marketType === "spot")
    .reduce((sum, record) => sum + numberValue(record.notionalUsd), 0);
  const futuresNotional = records
    .filter((record) => record.marketType === "futures")
    .reduce((sum, record) => sum + numberValue(record.notionalUsd), 0);

  return {
    totalNotionalUsd: decimalString(totalNotional, 2),
    totalFeeUsd: decimalString(totalFee, 2),
    totalRealizedPnlUsd: decimalString(totalRealizedPnl, 2),
    winRatePct: realizedRecords.length
      ? decimalString((winningRecords.length / realizedRecords.length) * 100, 2)
      : "0.00",
    tradeCount: records.length,
    spotNotionalUsd: decimalString(spotNotional, 2),
    futuresNotionalUsd: decimalString(futuresNotional, 2),
  };
}

async function fetchFuturesContractDetails(
  client,
  futuresTrades,
  partialFailures
) {
  const contracts = Array.from(
    new Set(futuresTrades.map(futuresContractKey).filter(Boolean))
  );
  const details = new Map();
  if (!contracts.length) return details;

  const results = await Promise.allSettled(
    contracts.map(async (contract) => {
      if (typeof client.getFuturesUsdtContractRaw !== "function") {
        throw new Error(
          "Gate futures contract metadata client is unavailable."
        );
      }
      const result = await client.getFuturesUsdtContractRaw({ contract });
      if (!result?.success) {
        throw new Error(
          result?.safeErrorMessage ||
            `Gate futures contract metadata failed: ${contract}`
        );
      }
      return { contract, data: result.data };
    })
  );

  results.forEach((result, index) => {
    const contract = contracts[index];
    if (result.status === "fulfilled") {
      details.set(contract, result.value.data);
      return;
    }
    pushPartialFailure(partialFailures, {
      source: "futures_contract_metadata",
      message: safeErrorMessage(result.reason),
    });
  });

  return details;
}

async function fetchFuturesOrderDetails(
  client,
  futuresTrades,
  partialFailures
) {
  const orders = new Map();
  for (const trade of futuresTrades) {
    const key = futuresOrderKey(trade);
    if (!key || orders.has(key)) continue;
    orders.set(key, {
      contract: futuresContractKey(trade),
      orderId: String(firstPresent(trade, ["order_id", "orderId"], "")),
    });
  }

  if (!orders.size) return new Map();
  const entries = Array.from(orders.entries());
  const details = new Map();

  if (typeof client.getFuturesUsdtOrderRaw !== "function") {
    pushPartialFailure(partialFailures, {
      source: "futures_order_metadata",
      message: "Gate futures order metadata client is unavailable.",
    });
    return details;
  }

  const results = await Promise.allSettled(
    entries.map(async ([_, order]) => {
      const result = await client.getFuturesUsdtOrderRaw(order);
      if (!result?.success) {
        throw new Error(
          result?.safeErrorMessage ||
            `Gate futures order metadata failed: ${order.orderId}`
        );
      }
      return result.data;
    })
  );

  results.forEach((result, index) => {
    const [key, order] = entries[index];
    if (result.status === "fulfilled") {
      details.set(key, result.value);
      return;
    }
    pushPartialFailure(partialFailures, {
      source: "futures_order_metadata",
      message:
        safeErrorMessage(result.reason) ||
        `Gate futures order metadata failed: ${order.orderId}`,
    });
  });

  return details;
}

async function fetchFuturesPositionCloses({
  client,
  fromSec,
  toSec,
  batchLimit,
  partialFailures,
}) {
  if (typeof client.getFuturesUsdtPositionCloseRaw !== "function") {
    return [];
  }

  try {
    const result = await client.getFuturesUsdtPositionCloseRaw({
      limit: batchLimit,
      from: fromSec,
      to: toSec,
    });
    if (!result?.success) {
      throw new Error(
        result?.safeErrorMessage || "Gate futures position close failed."
      );
    }
    return asArray(result.data);
  } catch (error) {
    pushPartialFailure(partialFailures, {
      source: "futures_position_close",
      message: safeErrorMessage(error),
    });
    return [];
  }
}

function orderDetailsForRecord(record, orderDetails = new Map()) {
  const orderId = String(record?.orderId || "").trim();
  if (!orderId || orderId === "--") return null;
  return (
    orderDetails.get(`${futuresContractKeyForRecord(record)}:${orderId}`) ||
    null
  );
}

function directMarginBasis(positionClose, orderDetails) {
  return (
    firstPositiveNumber(positionClose?.raw || {}, [
      "margin",
      "position_margin",
      "initial_margin",
      "open_margin",
      "order_margin",
      "close_margin",
      "margin_basis",
    ]) ||
    firstPositiveNumber(orderDetails || {}, [
      "margin",
      "position_margin",
      "initial_margin",
      "open_margin",
      "order_margin",
      "close_margin",
      "margin_basis",
    ])
  );
}

function leverageValue(positionClose, orderDetails) {
  return (
    firstPositiveNumber(positionClose?.raw || {}, [
      "leverage",
      "lever",
      "leverage_max",
    ]) ||
    firstPositiveNumber(orderDetails || {}, [
      "leverage",
      "lever",
      "leverage_max",
    ])
  );
}

function realizedPnlPctForClose(record, positionClose, orderDetails) {
  const pnl = numberValue(positionClose?.pnl, NaN);
  if (!Number.isFinite(pnl)) return null;

  const directPct = firstPresent(
    positionClose?.raw || {},
    ["pnl_pct", "pnl_percent", "pnl_rate", "roi", "roi_pct", "roi_percent"],
    null
  );
  if (directPct !== null) {
    const pct = numberValue(directPct, NaN);
    if (Number.isFinite(pct)) {
      return decimalString(Math.abs(pct) <= 10 ? pct * 100 : pct, 2);
    }
  }

  let marginBasis = directMarginBasis(positionClose, orderDetails);
  if (marginBasis <= 0) {
    const leverage = leverageValue(positionClose, orderDetails);
    const notional =
      firstPositiveNumber(positionClose?.raw || {}, [
        "notional_usd",
        "notional",
        "position_value",
        "value",
      ]) || numberValue(record?.notionalUsd, 0);
    if (leverage > 0 && notional > 0) marginBasis = notional / leverage;
  }

  if (marginBasis <= 0) return null;
  return decimalString((pnl / marginBasis) * 100, 2);
}

function positionCloseMatchScore(record, positionClose) {
  if (record.marketType !== "futures") return null;
  if (!isFuturesCloseAction(record.action)) return null;
  if (positionSideForCloseAction(record.action) !== positionClose.side)
    return null;
  if (compactSymbol(positionClose.contract) !== record.symbol) return null;

  const timeDiff = Math.abs(
    numberValue(record.ts) - numberValue(positionClose.ts)
  );
  if (timeDiff > 15 * 60 * 1000) return null;

  const recordPrice = numberValue(record.price, 0);
  const closePrice = numberValue(positionClose.closePrice, 0);
  let priceScore = 0;
  if (recordPrice > 0 && closePrice > 0) {
    const priceDiff = Math.abs(recordPrice - closePrice);
    const allowedDiff = Math.max(0.05, recordPrice * 0.001);
    if (priceDiff > allowedDiff) return null;
    priceScore = priceDiff * 10_000;
  }

  return timeDiff + priceScore;
}

function applyPositionClosePnl(
  records,
  positionCloseRows,
  { orderDetails = new Map() } = {}
) {
  const positionCloses = asArray(positionCloseRows)
    .map((row, index) => normalizePositionClose(row, index))
    .filter(Boolean);
  if (!positionCloses.length) return records;

  const used = new Set();
  return records.map((record) => {
    if (
      record.marketType !== "futures" ||
      !isFuturesCloseAction(record.action)
    ) {
      return record;
    }

    const best = positionCloses
      .filter((positionClose) => !used.has(positionClose.index))
      .map((positionClose) => ({
        positionClose,
        score: positionCloseMatchScore(record, positionClose),
      }))
      .filter((candidate) => candidate.score !== null)
      .sort((left, right) => left.score - right.score)[0];

    if (!best) return record;
    used.add(best.positionClose.index);

    return {
      ...record,
      realizedPnlUsd: decimalString(best.positionClose.pnl, 2),
      realizedPnlPct: realizedPnlPctForClose(
        record,
        best.positionClose,
        orderDetailsForRecord(record, orderDetails)
      ),
      realizedPnlSource: "position_close",
    };
  });
}

function applyCycleEstimatedPnl(records, cycles = []) {
  const estimatedByCloseRecordId = new Map();
  for (const cycle of cycles || []) {
    for (const match of cycle.matches || []) {
      const closeTradeId = String(match?.closeTradeId || "");
      if (!closeTradeId || match?.pnlSource !== "estimated") continue;
      estimatedByCloseRecordId.set(
        closeTradeId,
        numberValue(estimatedByCloseRecordId.get(closeTradeId)) +
          numberValue(match.pnlUsd)
      );
    }
  }
  if (!estimatedByCloseRecordId.size) return records;

  return records.map((record) => {
    if (
      record.marketType !== "futures" ||
      !isFuturesCloseAction(record.action) ||
      record.realizedPnlUsd !== null
    ) {
      return record;
    }
    const estimated = estimatedByCloseRecordId.get(record.id);
    if (estimated === undefined) return record;
    return {
      ...record,
      realizedPnlUsd: decimalString(estimated, 2),
      realizedPnlPct: null,
      realizedPnlSource: "cycle_estimated",
    };
  });
}

function normalizeOpenPositionsForCycles(rawPositions) {
  return asArray(rawPositions).map(normalizePosition).filter(Boolean);
}

function historyCoverageForWindow({
  fromSec,
  toSec,
  requestedToSec,
  oldestRaw,
  batchLimit,
  hasMoreHistory,
}) {
  return {
    requestedFrom: fromSec,
    requestedTo: requestedToSec,
    loadedFrom: oldestRaw ? Math.floor(oldestRaw.ts / 1000) : fromSec,
    loadedTo: toSec,
    effectiveTo: toSec,
    batchLimit,
    hasMoreBefore: hasMoreHistory,
  };
}

function sseWrite(response, event, payload) {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

class GateTradeRecordsService {
  constructor({
    restClientFactory = () => new GateRestClient(),
    wsManager = cryptoGateWsManager,
    cycleMemoryStore = new SystemSettingsTradeCycleMemoryStore(),
  } = {}) {
    this.restClientFactory = restClientFactory;
    this.wsManager = wsManager;
    this.cycleMemoryStore = cycleMemoryStore;
    this.subscribers = new Map();
    this.unsubscribePrivateEvents = null;
    this.futuresContractDetails = new Map();
    this.futuresOrderDetails = new Map();
  }

  async snapshot({
    from,
    to,
    cursorTs,
    limit = DEFAULT_BATCH_LIMIT,
    debugFeeFields = false,
  } = {}) {
    const batchLimit = clampInteger(
      limit,
      DEFAULT_BATCH_LIMIT,
      1,
      MAX_BATCH_LIMIT
    );
    const { fromSec, toSec, requestedToSec } = normalizeWindow({
      from,
      to,
      cursorTs,
    });
    const client = this.restClientFactory();
    const [spotResult, futuresResult, positionsResult] =
      await Promise.allSettled([
        client.getSpotMyTradesRaw({
          limit: batchLimit,
          from: fromSec,
          to: toSec,
        }),
        client.getFuturesUsdtMyTradesRaw({
          limit: batchLimit,
          from: fromSec,
          to: toSec,
        }),
        typeof client.getFuturesUsdtPositionsRaw === "function"
          ? client.getFuturesUsdtPositionsRaw({ holding: true })
          : Promise.resolve({ success: true, data: [] }),
      ]);
    const partialFailures = [];
    const records = [];
    let openPositions = [];
    let spotTradesForDebug = [];
    let failedMarketRequests = 0;
    let futuresPositionCloses = [];
    let futuresOrderDetailsForSnapshot = new Map();

    if (spotResult.status === "fulfilled" && spotResult.value?.success) {
      const spotTrades = asArray(spotResult.value.data);
      spotTradesForDebug = spotTrades;
      let tickerPrices = new Map();
      if (spotTrades.some(spotFeeNeedsTicker)) {
        const tickerResult = await client.getSpotTickersRaw();
        if (tickerResult?.success) {
          tickerPrices = tickerMapByPair(tickerResult.data);
        } else {
          partialFailures.push({
            source: "spot_fee_tickers",
            message:
              tickerResult?.safeErrorMessage ||
              "Gate spot fee ticker fetch failed.",
          });
        }
      }
      records.push(
        ...spotTrades
          .map((trade) =>
            normalizeSpotTrade(trade, { tickerPrices, partialFailures })
          )
          .filter(Boolean)
      );
    } else {
      failedMarketRequests += 1;
      partialFailures.push({
        source: "spot_my_trades",
        message:
          spotResult.status === "fulfilled"
            ? spotResult.value?.safeErrorMessage || "Gate spot trades failed."
            : safeErrorMessage(spotResult.reason),
      });
    }

    if (futuresResult.status === "fulfilled" && futuresResult.value?.success) {
      const futuresTrades = asArray(futuresResult.value.data);
      const [contractDetails, orderDetails, positionCloses] = await Promise.all(
        [
          fetchFuturesContractDetails(client, futuresTrades, partialFailures),
          fetchFuturesOrderDetails(client, futuresTrades, partialFailures),
          fetchFuturesPositionCloses({
            client,
            fromSec,
            toSec,
            batchLimit,
            partialFailures,
          }),
        ]
      );
      futuresPositionCloses = positionCloses;
      futuresOrderDetailsForSnapshot = orderDetails;
      for (const [key, value] of contractDetails.entries()) {
        this.futuresContractDetails.set(key, value);
      }
      for (const [key, value] of orderDetails.entries()) {
        this.futuresOrderDetails.set(key, value);
      }
      records.push(
        ...futuresTrades
          .map((trade) =>
            normalizeFuturesTrade(trade, {
              contractDetails,
              orderDetails,
              partialFailures,
            })
          )
          .filter(Boolean)
      );
    } else {
      failedMarketRequests += 1;
      partialFailures.push({
        source: "futures_my_trades",
        message:
          futuresResult.status === "fulfilled"
            ? futuresResult.value?.safeErrorMessage ||
              "Gate futures trades failed."
            : safeErrorMessage(futuresResult.reason),
      });
    }

    if (
      positionsResult.status === "fulfilled" &&
      positionsResult.value?.success
    ) {
      openPositions = normalizeOpenPositionsForCycles(
        positionsResult.value.data
      );
    } else if (typeof client.getFuturesUsdtPositionsRaw === "function") {
      partialFailures.push({
        source: "futures_open_positions",
        message:
          positionsResult.status === "fulfilled"
            ? positionsResult.value?.safeErrorMessage ||
              "Gate futures open positions failed."
            : safeErrorMessage(positionsResult.reason),
      });
    }

    if (failedMarketRequests === 2) {
      const error = new Error("Gate trade records failed.");
      error.partialFailures = partialFailures;
      throw error;
    }

    const rawSorted = dedupeRecords(records).slice(0, batchLimit);
    const sorted = applyPositionClosePnl(
      aggregateOrderRecords(rawSorted),
      futuresPositionCloses,
      { orderDetails: futuresOrderDetailsForSnapshot }
    );
    const oldestRaw = rawSorted[rawSorted.length - 1];
    const hasMoreHistory =
      Boolean(oldestRaw) &&
      rawSorted.length >= batchLimit &&
      oldestRaw.ts / 1000 > fromSec;
    const historyCoverage = historyCoverageForWindow({
      fromSec,
      toSec,
      requestedToSec,
      oldestRaw,
      batchLimit,
      hasMoreHistory,
    });
    let cycleMemory = [];
    try {
      cycleMemory = await this.cycleMemoryStore.load();
    } catch (error) {
      partialFailures.push({
        source: "trade_cycle_memory",
        message: safeErrorMessage(error),
      });
    }
    const cycleResult = buildTradeCycles({
      records: sorted,
      historyCoverage,
      openPositions,
      cycleMemory,
    });
    const finalRecords = applyCycleEstimatedPnl(
      cycleResult.records,
      cycleResult.cycles
    );
    try {
      await this.cycleMemoryStore.saveCompleteCycles(cycleResult.memoryUpdates);
    } catch (error) {
      partialFailures.push({
        source: "trade_cycle_memory",
        message: safeErrorMessage(error),
      });
    }

    return {
      success: true,
      asOf: Date.now(),
      exchange: "gate",
      marketType: "all",
      settle: DEFAULT_SETTLE,
      range: {
        from: fromSec,
        to: requestedToSec,
        effectiveTo: toSec,
      },
      batchLimit,
      historyCoverage,
      cycles: cycleResult.cycles,
      records: finalRecords,
      summary: summarizeRecords(finalRecords),
      hasMoreHistory,
      nextCursorTs: oldestRaw
        ? Math.max(fromSec * 1000, oldestRaw.ts - 1)
        : null,
      connectionStatus: partialFailures.length ? "degraded" : "connected",
      partialFailures,
      ...(debugFeeFields
        ? { debugFeeFields: spotTradesForDebug.map(feeDebugFields) }
        : {}),
    };
  }

  normalizePrivateTradeEvent(event) {
    const updates = asArray(event?.payload?.result ?? event?.payload);
    const partialFailures = [];
    let records = [];
    if (event?.source === "spot") {
      records = updates
        .map((trade) => normalizeSpotTrade(trade, { partialFailures }))
        .filter(Boolean);
    } else if (event?.source === "futures_usdt") {
      records = updates
        .map((trade) =>
          normalizeFuturesTrade(trade, {
            contractDetails: this.futuresContractDetails,
            orderDetails: this.futuresOrderDetails,
            partialFailures,
          })
        )
        .filter(Boolean);
    }
    return {
      records: aggregateOrderRecords(dedupeRecords(records)),
      partialFailures,
    };
  }

  handlePrivateEvent(event) {
    if (event?.eventType !== "trade") return;
    const { records, partialFailures } = this.normalizePrivateTradeEvent(event);
    if (!records.length) return;
    this.broadcast("update", {
      success: true,
      asOf: Date.now(),
      exchange: "gate",
      marketType: "all",
      records,
      summary: summarizeRecords(records),
      connectionStatus: partialFailures.length ? "degraded" : "connected",
      partialFailures,
    });
  }

  prepareSseResponse(response) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders?.();
  }

  ensurePrivateWs() {
    if (!this.unsubscribePrivateEvents) {
      this.unsubscribePrivateEvents = this.wsManager.addPrivateEventListener(
        (event) => this.handlePrivateEvent(event)
      );
    }
    this.wsManager.start(getGateCredentials());
  }

  async subscribe(response, query = {}) {
    const id = `${Date.now()}:${Math.random().toString(16).slice(2)}`;
    this.prepareSseResponse(response);
    this.subscribers.set(id, response);
    const unsubscribe = () => this.subscribers.delete(id);
    response.on("close", unsubscribe);
    response.on("error", unsubscribe);

    try {
      sseWrite(response, "snapshot", await this.snapshot(query));
      this.ensurePrivateWs();
    } catch (error) {
      sseWrite(response, "error", {
        success: false,
        asOf: Date.now(),
        exchange: "gate",
        marketType: "all",
        connectionStatus: "disconnected",
        safeErrorMessage: safeErrorMessage(error),
        records: [],
        summary: summarizeRecords([]),
        partialFailures: Array.isArray(error?.partialFailures)
          ? error.partialFailures
          : [],
      });
      response.end();
    }
    return unsubscribe;
  }

  broadcast(event, payload) {
    for (const response of this.subscribers.values()) {
      sseWrite(response, event, payload);
    }
  }
}

const cryptoGateTradeRecordsService = new GateTradeRecordsService();

module.exports = {
  GateTradeRecordsService,
  cryptoGateTradeRecordsService,
  summarizeRecords,
  aggregateOrderRecords,
};
