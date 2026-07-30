#!/usr/bin/env node

const crypto = require("node:crypto");
const path = require("node:path");
const AdmZip = require("adm-zip");
const {
  SUPPORTED_SYMBOLS,
  forecastingRoot,
} = require("../utils/cryptoForecasting/constants");
const { CryptoForecastStore } = require("../utils/cryptoForecasting/store");
const { timestampMs } = require("../utils/cryptoForecasting/binance");

const ARCHIVE_BASE = "https://data.binance.vision/data/futures/um";
const SERIES = Object.freeze({
  contract: { directory: "klines", storedInterval: "5m" },
  mark: { directory: "markPriceKlines", storedInterval: "5m" },
  index: { directory: "indexPriceKlines", storedInterval: "1h" },
  premium: { directory: "premiumIndexKlines", storedInterval: "1h" },
});

function option(name, fallback = null) {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function monthValue(value) {
  if (!/^\d{4}-\d{2}$/.test(value || "")) throw new Error("invalid_month");
  return value;
}

function monthsBetween(from, to) {
  const result = [];
  let [year, month] = from.split("-").map(Number);
  const [endYear, endMonth] = to.split("-").map(Number);
  while (year < endYear || (year === endYear && month <= endMonth)) {
    result.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      year += 1;
      month = 1;
    }
  }
  return result;
}

function datesBetween(from, to) {
  const result = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(cursor.valueOf()) || !Number.isFinite(end.valueOf()))
    throw new Error("invalid_date");
  while (cursor <= end) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

async function download(url, { retries = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
        headers: { Accept: "application/octet-stream,text/plain" },
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`http_${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < retries)
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

function parseChecksum(buffer, fileName) {
  const line = buffer.toString("utf8").trim().split(/\r?\n/)[0] || "";
  const [digest, name] = line.split(/\s+/);
  if (!/^[a-f0-9]{64}$/i.test(digest) || path.basename(name || "") !== fileName)
    throw new Error("checksum_manifest_invalid");
  return digest.toLowerCase();
}

async function verifiedCsv(url, fileName) {
  const [archive, checksum] = await Promise.all([
    download(url),
    download(`${url}.CHECKSUM`),
  ]);
  if (!archive || !checksum) return null;
  if (sha256(archive) !== parseChecksum(checksum, fileName))
    throw new Error(`checksum_mismatch:${fileName}`);
  const entries = new AdmZip(archive)
    .getEntries()
    .filter((entry) => !entry.isDirectory);
  if (entries.length !== 1)
    throw new Error(`archive_shape_invalid:${fileName}`);
  return {
    csv: entries[0].getData().toString("utf8"),
    archiveSha256: sha256(archive),
  };
}

function dataLines(csv) {
  return csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /^\d/.test(line));
}

function parseDerivativeKlines(csv, { symbol, seriesType }) {
  return dataLines(csv)
    .map((line) => line.split(","))
    .map((columns) => {
      const openTimeMs = timestampMs(columns[0]);
      const closeTimeMs = timestampMs(columns[6]);
      const values = columns.slice(1, 5).map(Number);
      if (
        !Number.isFinite(openTimeMs) ||
        !Number.isFinite(closeTimeMs) ||
        !values.every(Number.isFinite)
      )
        return null;
      return {
        symbol,
        seriesType,
        interval: "5m",
        openTimeMs,
        closeTimeMs,
        open: values[0],
        high: values[1],
        low: values[2],
        close: values[3],
        source: "binance_public_data",
        availableAtMs: closeTimeMs + 1,
      };
    })
    .filter(Boolean);
}

function aggregateDerivativeKlines(rows, intervalMs, interval) {
  const buckets = new Map();
  for (const row of rows) {
    const bucket = Math.floor(row.openTimeMs / intervalMs) * intervalMs;
    const values = buckets.get(bucket) || [];
    values.push(row);
    buckets.set(bucket, values);
  }
  const expected = intervalMs / (5 * 60_000);
  return [...buckets.entries()]
    .map(([bucket, values]) => {
      values.sort((left, right) => left.openTimeMs - right.openTimeMs);
      if (
        values.length !== expected ||
        values.some(
          (row, index) => row.openTimeMs !== bucket + index * 5 * 60_000
        )
      )
        return null;
      return {
        ...values[0],
        interval,
        openTimeMs: bucket,
        closeTimeMs: bucket + intervalMs - 1,
        open: values[0].open,
        high: Math.max(...values.map((row) => row.high)),
        low: Math.min(...values.map((row) => row.low)),
        close: values.at(-1).close,
        availableAtMs: bucket + intervalMs,
      };
    })
    .filter(Boolean);
}

function parseFundingRates(csv, { symbol }) {
  return dataLines(csv)
    .map((line) => line.split(","))
    .map((columns) => {
      const calcTimeMs = timestampMs(columns[0]);
      const fundingIntervalHours = Number(columns[1]);
      const fundingRate = Number(columns[2]);
      if (!Number.isFinite(calcTimeMs) || !Number.isFinite(fundingRate))
        return null;
      return {
        symbol,
        calcTimeMs,
        fundingIntervalHours: Number.isFinite(fundingIntervalHours)
          ? fundingIntervalHours
          : null,
        fundingRate,
        source: "binance_public_data",
        availableAtMs: calcTimeMs + 1,
      };
    })
    .filter(Boolean);
}

function parseMetrics(csv, { symbol }) {
  return dataLines(csv)
    .map((line) => line.split(","))
    .map((columns) => {
      const createTimeMs = Date.parse(columns[0]);
      const values = columns.slice(2, 8).map(Number);
      if (!Number.isFinite(createTimeMs)) return null;
      return {
        symbol,
        createTimeMs,
        sumOpenInterest: Number.isFinite(values[0]) ? values[0] : null,
        sumOpenInterestValue: Number.isFinite(values[1]) ? values[1] : null,
        countToptraderLongShortRatio: Number.isFinite(values[2])
          ? values[2]
          : null,
        sumToptraderLongShortRatio: Number.isFinite(values[3])
          ? values[3]
          : null,
        countLongShortRatio: Number.isFinite(values[4]) ? values[4] : null,
        sumTakerLongShortVolRatio: Number.isFinite(values[5])
          ? values[5]
          : null,
        source: "binance_public_data",
        availableAtMs: createTimeMs + 5 * 60_000,
      };
    })
    .filter(Boolean);
}

async function processMonthly({ store, symbol, month, apply }) {
  const pair = `${symbol}USDT`;
  const records = [];
  for (const [seriesType, config] of Object.entries(SERIES)) {
    const fileName = `${pair}-5m-${month}.zip`;
    const url = `${ARCHIVE_BASE}/monthly/${config.directory}/${pair}/5m/${fileName}`;
    const result = await verifiedCsv(url, fileName);
    if (!result) {
      records.push({ symbol, month, seriesType, status: "unavailable" });
      continue;
    }
    const parsed = parseDerivativeKlines(result.csv, { symbol, seriesType });
    const rows =
      config.storedInterval === "1h"
        ? aggregateDerivativeKlines(parsed, 60 * 60_000, "1h")
        : parsed;
    if (apply) store.upsertDerivativeKlines(rows);
    records.push({
      symbol,
      month,
      seriesType,
      status: "complete",
      rows: rows.length,
      sourceRows: parsed.length,
      storedInterval: config.storedInterval,
      sourceSha256: result.archiveSha256,
    });
  }
  const fundingName = `${pair}-fundingRate-${month}.zip`;
  const fundingUrl = `${ARCHIVE_BASE}/monthly/fundingRate/${pair}/${fundingName}`;
  const funding = await verifiedCsv(fundingUrl, fundingName);
  if (funding) {
    const rows = parseFundingRates(funding.csv, { symbol });
    if (apply) store.upsertFundingRates(rows);
    records.push({
      symbol,
      month,
      seriesType: "funding_rate",
      status: "complete",
      rows: rows.length,
      sourceSha256: funding.archiveSha256,
    });
  } else
    records.push({
      symbol,
      month,
      seriesType: "funding_rate",
      status: "unavailable",
    });
  return records;
}

async function processMetricsDay({ store, symbol, date, apply }) {
  const pair = `${symbol}USDT`;
  const fileName = `${pair}-metrics-${date}.zip`;
  const url = `${ARCHIVE_BASE}/daily/metrics/${pair}/${fileName}`;
  const result = await verifiedCsv(url, fileName);
  if (!result) return { symbol, date, status: "unavailable" };
  const rows = parseMetrics(result.csv, { symbol });
  if (apply) store.upsertDerivativeMetrics(rows);
  return {
    symbol,
    date,
    status: "complete",
    rows: rows.length,
    sourceSha256: result.archiveSha256,
  };
}

async function main() {
  const now = new Date();
  const previousMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)
  );
  const from = monthValue(option("from", "2021-01"));
  const to = monthValue(
    option(
      "to",
      `${previousMonth.getUTCFullYear()}-${String(
        previousMonth.getUTCMonth() + 1
      ).padStart(2, "0")}`
    )
  );
  const metricsFrom = option(
    "metrics-from",
    new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10)
  );
  const metricsTo = option(
    "metrics-to",
    new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  );
  const symbols = option("symbols", SUPPORTED_SYMBOLS.join(","))
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter((value) => SUPPORTED_SYMBOLS.includes(value));
  const apply = process.argv.includes("--apply");
  const root = path.resolve(option("root", forecastingRoot()));
  const store = new CryptoForecastStore({ root });
  const records = [];
  try {
    for (const symbol of symbols) {
      for (const month of monthsBetween(from, to)) {
        if (!store.capacity().allowed)
          throw new Error(`capacity_guard:${store.capacity().reason}`);
        const monthly = await processMonthly({ store, symbol, month, apply });
        records.push(...monthly);
        process.stdout.write(`${JSON.stringify(monthly)}\n`);
      }
      for (const date of datesBetween(metricsFrom, metricsTo)) {
        if (!store.capacity().allowed)
          throw new Error(`capacity_guard:${store.capacity().reason}`);
        const record = await processMetricsDay({
          store,
          symbol,
          date,
          apply,
        });
        records.push(record);
        process.stdout.write(`${JSON.stringify(record)}\n`);
      }
    }
    const manifest = {
      schema: "athena.crypto.derivatives-dataset",
      schemaVersion: "1.0",
      generatedAt: new Date().toISOString(),
      source: "binance_public_data",
      from,
      to,
      metricsFrom,
      metricsTo,
      symbols,
      records,
    };
    const manifestSha256 = sha256(Buffer.from(JSON.stringify(manifest)));
    if (apply) store.saveDatasetManifest(manifest);
    process.stdout.write(
      `${JSON.stringify({
        apply,
        manifestSha256,
        records: records.length,
        coverage: store.derivativeCoverage(),
      })}\n`
    );
  } finally {
    store.close();
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(
      JSON.stringify({ error: error?.code || error?.message || "failed" })
    );
    process.exitCode = 1;
  });

module.exports = {
  SERIES,
  aggregateDerivativeKlines,
  dataLines,
  datesBetween,
  monthsBetween,
  parseDerivativeKlines,
  parseFundingRates,
  parseMetrics,
};
