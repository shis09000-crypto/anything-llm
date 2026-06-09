const { GateRestClient } = require("./restClient");
const { safeErrorMessage } = require("./sanitizer");

const MAX_ACCOUNT_BOOK_WINDOW_SECONDS = 30 * 24 * 60 * 60;
const YEAR_SECONDS = 365 * 24 * 60 * 60;
const ACCOUNT_BOOK_LIMIT = 100;
const MAX_PAGES_PER_WINDOW = 100;
const STABLE_FEE_ASSETS = new Set(["USD", "USDT", "USDC", "GUSD", "DAI"]);

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.result)) return value.result;
  if (Array.isArray(value?.records)) return value.records;
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

function normalizeAsset(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/-/g, "_");
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

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function normalizeRange({ from, to } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const toSec = clampInteger(to, nowSec, 0, nowSec);
  const fromSec = clampInteger(from, toSec - 30 * 24 * 60 * 60, 0, toSec);
  return { fromSec, toSec };
}

function splitRangeIntoWindows(fromSec, toSec) {
  const windows = [];
  let cursor = fromSec;
  while (cursor <= toSec) {
    const windowTo = Math.min(
      toSec,
      cursor + MAX_ACCOUNT_BOOK_WINDOW_SECONDS - 1
    );
    windows.push({ from: cursor, to: windowTo });
    cursor = windowTo + 1;
  }
  return windows;
}

function tickerMapByPair(tickers = []) {
  const map = new Map();
  if (!Array.isArray(tickers)) return map;
  for (const ticker of tickers) {
    const pair = normalizeAsset(ticker?.currency_pair);
    const price = numberValue(firstPresent(ticker, ["last", "close"]), 0);
    if (pair && price > 0) map.set(pair, price);
  }
  return map;
}

function assetToUsdRate(asset, tickerPrices = new Map()) {
  const normalized = normalizeAsset(asset);
  if (STABLE_FEE_ASSETS.has(normalized)) return 1;
  return numberValue(tickerPrices.get(`${normalized}_USDT`), 0);
}

function accountBookTime(record) {
  const raw = firstPresent(record, [
    "time",
    "create_time",
    "created_at",
    "timestamp",
    "update_time",
  ]);
  const number = numberValue(raw, 0);
  if (!number) return 0;
  return number > 10_000_000_000
    ? Math.floor(number)
    : Math.floor(number * 1000);
}

function accountBookAmount(record) {
  const raw = firstPresent(record, [
    "change",
    "amount",
    "delta",
    "balance_change",
    "change_amount",
  ]);
  return Math.abs(numberValue(raw, 0));
}

function accountBookCurrency(record, fallback = "USDT") {
  return normalizeAsset(
    firstPresent(record, ["currency", "settle", "asset", "token"], fallback)
  );
}

function accountBookKey(market, record) {
  return [
    market,
    firstPresent(record, ["id", "text"], ""),
    accountBookTime(record),
    accountBookCurrency(record),
    firstPresent(record, ["change", "amount", "delta"], ""),
    firstPresent(record, ["type", "code"], ""),
  ].join(":");
}

function feeSourceForRecord(record) {
  const currency = accountBookCurrency(record);
  const type = String(firstPresent(record, ["type"], "")).toLowerCase();
  const code = String(firstPresent(record, ["code"], "")).toLowerCase();
  if (currency === "GT") return "gt";
  if (
    currency.includes("POINT") ||
    type === "point_fee" ||
    code === "point_fee" ||
    type.includes("point")
  ) {
    return "point";
  }
  return "asset";
}

function normalizedBookType(record) {
  return String(firstPresent(record, ["type"], ""))
    .trim()
    .toLowerCase();
}

function normalizedBookCode(record) {
  return String(firstPresent(record, ["code"], ""))
    .trim()
    .toLowerCase();
}

function isSpotFeeRecord(record) {
  const type = normalizedBookType(record);
  const code = normalizedBookCode(record);
  return (
    code === "151" ||
    type === "fee" ||
    type === "spot_fee" ||
    type === "trading_fee" ||
    type === "trading fees"
  );
}

function isFuturesFeeRecord(record) {
  const type = normalizedBookType(record);
  const code = normalizedBookCode(record);
  return code === "fee" || type === "fee";
}

function isFuturesPointFeeRecord(record) {
  const type = normalizedBookType(record);
  const code = normalizedBookCode(record);
  return code === "point_fee" || type === "point_fee";
}

function filterFeeAccountBookRecords(records, { market, type, code }) {
  if (market === "spot") {
    return records.filter(isSpotFeeRecord);
  }
  if (market === "futures" && type === "point_fee") {
    return records.filter(isFuturesPointFeeRecord);
  }
  if (market === "futures" && type === "fee") {
    return records.filter(isFuturesFeeRecord);
  }
  if (code) {
    const expectedCode = String(code).toLowerCase();
    return records.filter(
      (record) => normalizedBookCode(record) === expectedCode
    );
  }
  if (type) {
    const expectedType = String(type).toLowerCase();
    return records.filter(
      (record) => normalizedBookType(record) === expectedType
    );
  }
  return records;
}

function convertFeeRecord(record, { market, tickerPrices, partialFailures }) {
  const feeAmount = accountBookAmount(record);
  const currency = accountBookCurrency(
    record,
    market === "futures" ? "USDT" : ""
  );
  const feeSource = feeAmount > 0 ? feeSourceForRecord(record) : "zero";

  if (feeAmount <= 0) return { usd: 0, feeSource, currency, amount: feeAmount };
  if (feeSource === "point") {
    pushPartialFailure(partialFailures, {
      source: `${market}_fee_summary_point_fee`,
      message: "点卡抵扣手续费未确认等值单位，未计入 USD 手续费总额。",
    });
    return { usd: 0, feeSource, currency: "POINT", amount: feeAmount };
  }

  const rate = assetToUsdRate(currency, tickerPrices);
  if (rate > 0) {
    return {
      usd: feeAmount * rate,
      feeSource,
      currency,
      amount: feeAmount,
    };
  }

  pushPartialFailure(partialFailures, {
    source: `${market}_fee_summary_conversion`,
    message: `手续费总额折算缺价格：${currency}_USDT`,
  });
  return { usd: 0, feeSource: "unknown", currency, amount: feeAmount };
}

async function fetchPagedAccountBook({
  client,
  market,
  from,
  to,
  type,
  code,
  partialFailures,
}) {
  const records = [];
  for (const window of splitRangeIntoWindows(from, to)) {
    for (let page = 1; page <= MAX_PAGES_PER_WINDOW; page += 1) {
      const result =
        market === "spot"
          ? await client.getSpotAccountBook({
              from: window.from,
              to: window.to,
              page,
              limit: ACCOUNT_BOOK_LIMIT,
              type,
              code,
            })
          : await client.getFuturesUsdtAccountBook({
              from: window.from,
              to: window.to,
              offset: (page - 1) * ACCOUNT_BOOK_LIMIT,
              limit: ACCOUNT_BOOK_LIMIT,
              type,
            });

      if (!result?.success) {
        pushPartialFailure(partialFailures, {
          source: `${market}_fee_summary_account_book`,
          message:
            result?.safeErrorMessage ||
            `${market} account book request failed.`,
        });
        break;
      }

      const pageRecords = filterFeeAccountBookRecords(asArray(result.data), {
        market,
        type,
        code,
      });
      records.push(...pageRecords);
      if (asArray(result.data).length < ACCOUNT_BOOK_LIMIT) break;
      if (page === MAX_PAGES_PER_WINDOW) {
        pushPartialFailure(partialFailures, {
          source: `${market}_fee_summary_account_book`,
          message: `${market} 手续费账本分页达到安全上限，结果可能不完整。`,
        });
      }
    }
  }
  return records;
}

async function fetchFeeAccountBookRecords({
  client,
  from,
  to,
  partialFailures,
}) {
  const [spotResult, futuresFeeResult, futuresPointFeeResult] =
    await Promise.allSettled([
      fetchPagedAccountBook({
        client,
        market: "spot",
        from,
        to,
        code: "151",
        partialFailures,
      }),
      fetchPagedAccountBook({
        client,
        market: "futures",
        from,
        to,
        type: "fee",
        partialFailures,
      }),
      fetchPagedAccountBook({
        client,
        market: "futures",
        from,
        to,
        type: "point_fee",
        partialFailures,
      }),
    ]);

  const records = [];
  for (const [market, result] of [
    ["spot", spotResult],
    ["futures", futuresFeeResult],
    ["futures", futuresPointFeeResult],
  ]) {
    if (result.status === "fulfilled") {
      records.push(
        ...result.value.map((record) => ({
          market,
          record,
        }))
      );
    } else {
      pushPartialFailure(partialFailures, {
        source: `${market}_fee_summary_account_book`,
        message: safeErrorMessage(result.reason),
      });
    }
  }

  const seen = new Set();
  return records.filter(({ market, record }) => {
    const key = accountBookKey(market, record);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function needsTicker(records) {
  return records.some(({ record }) => {
    const source = feeSourceForRecord(record);
    const currency = accountBookCurrency(record);
    return (
      source !== "point" &&
      accountBookAmount(record) > 0 &&
      !STABLE_FEE_ASSETS.has(currency)
    );
  });
}

async function tickerPricesFor(client, records, partialFailures) {
  if (!needsTicker(records)) return new Map();
  const result = await client.getSpotTickersRaw();
  if (result?.success) return tickerMapByPair(result.data);

  pushPartialFailure(partialFailures, {
    source: "fee_summary_tickers",
    message:
      result?.safeErrorMessage || "Gate fee summary ticker fetch failed.",
  });
  return new Map();
}

function summarizeFeeRecords(records, { tickerPrices, partialFailures }) {
  const totals = {
    spotUsd: 0,
    futuresUsd: 0,
    gtUsd: 0,
    pointAmount: 0,
    unknownUsd: 0,
  };

  for (const { market, record } of records) {
    const converted = convertFeeRecord(record, {
      market,
      tickerPrices,
      partialFailures,
    });
    if (converted.feeSource === "point") {
      totals.pointAmount += converted.amount;
      continue;
    }
    if (converted.feeSource === "gt") totals.gtUsd += converted.usd;
    if (converted.feeSource === "unknown") totals.unknownUsd += converted.usd;
    if (market === "spot") totals.spotUsd += converted.usd;
    if (market === "futures") totals.futuresUsd += converted.usd;
  }

  return {
    totalFeeUsd: totals.spotUsd + totals.futuresUsd,
    feeSources: {
      spotUsd: decimalString(totals.spotUsd, 2),
      futuresUsd: decimalString(totals.futuresUsd, 2),
      gtUsd: decimalString(totals.gtUsd, 2),
      pointAmount: decimalString(totals.pointAmount, 8),
      unknownUsd: decimalString(totals.unknownUsd, 2),
    },
  };
}

class GateTradeRecordsFeeSummaryService {
  constructor({ restClientFactory = () => new GateRestClient() } = {}) {
    this.restClientFactory = restClientFactory;
  }

  async summarizeRange({ client, from, to, partialFailures }) {
    const records = await fetchFeeAccountBookRecords({
      client,
      from,
      to,
      partialFailures,
    });
    const tickerPrices = await tickerPricesFor(
      client,
      records,
      partialFailures
    );
    return summarizeFeeRecords(records, { tickerPrices, partialFailures });
  }

  async snapshot({ from, to, includeYear = true } = {}) {
    const { fromSec, toSec } = normalizeRange({ from, to });
    const client = this.restClientFactory();
    const partialFailures = [];

    const current = await this.summarizeRange({
      client,
      from: fromSec,
      to: toSec,
      partialFailures,
    });

    let yearRange = null;
    let year = null;
    if (includeYear) {
      yearRange = {
        from: Math.max(0, toSec - YEAR_SECONDS),
        to: toSec,
      };
      year = await this.summarizeRange({
        client,
        from: yearRange.from,
        to: yearRange.to,
        partialFailures,
      });
    }

    return {
      success: true,
      exchange: "gate",
      asOf: Date.now(),
      range: {
        from: fromSec,
        to: toSec,
      },
      totalFeeUsd: decimalString(current.totalFeeUsd, 2),
      ...(yearRange && year
        ? {
            yearRange,
            yearTotalFeeUsd: decimalString(year.totalFeeUsd, 2),
          }
        : {}),
      feeSources: current.feeSources,
      connectionStatus: partialFailures.length ? "degraded" : "connected",
      partialFailures,
    };
  }
}

const cryptoGateTradeRecordsFeeSummaryService =
  new GateTradeRecordsFeeSummaryService();

module.exports = {
  GateTradeRecordsFeeSummaryService,
  cryptoGateTradeRecordsFeeSummaryService,
};
