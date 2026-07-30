#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const AdmZip = require("adm-zip");
const {
  SUPPORTED_SYMBOLS,
  forecastingRoot,
} = require("../utils/cryptoForecasting/constants");
const { normalizeKline } = require("../utils/cryptoForecasting/binance");
const {
  envelopeForBar,
} = require("../utils/cryptoForecasting/marketDataEnvelope");
const { CryptoForecastStore } = require("../utils/cryptoForecasting/store");

const ARCHIVE_BASE = "https://data.binance.vision/data/spot/monthly/klines";

function option(name, fallback = null) {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function monthValue(value) {
  if (!/^\d{4}-\d{2}$/.test(value || ""))
    throw new Error(`invalid_month:${value}`);
  const month = Number(value.slice(5));
  if (month < 1 || month > 12) throw new Error(`invalid_month:${value}`);
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
      month = 1;
      year += 1;
    }
  }
  return result;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function download(url, { retries = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/octet-stream,text/plain" },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`http_${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < retries)
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
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

function parseRows(csv, symbol) {
  const rows = [];
  for (const line of csv.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const columns = line.split(",");
    const bar = normalizeKline(columns, {
      symbol,
      interval: "1m",
      source: "binance_archive",
    });
    if (bar) rows.push(bar);
  }
  return rows.sort((left, right) => left.openTimeMs - right.openTimeMs);
}

function completeFiveMinuteBars(oneMinuteBars) {
  const buckets = new Map();
  for (const bar of oneMinuteBars) {
    const bucket = Math.floor(bar.openTimeMs / 300_000) * 300_000;
    const list = buckets.get(bucket) || [];
    list.push(bar);
    buckets.set(bucket, list);
  }
  const result = [];
  for (const [bucket, bars] of buckets) {
    bars.sort((left, right) => left.openTimeMs - right.openTimeMs);
    const complete =
      bars.length === 5 &&
      bars.every((bar, index) => bar.openTimeMs === bucket + index * 60_000);
    if (!complete) continue;
    const aggregated = {
      symbol: bars[0].symbol,
      interval: "5m",
      openTimeMs: bucket,
      closeTimeMs: bucket + 300_000 - 1,
      open: bars[0].open,
      high: Math.max(...bars.map((bar) => bar.high)),
      low: Math.min(...bars.map((bar) => bar.low)),
      close: bars.at(-1).close,
      volume: bars.reduce((sum, bar) => sum + bar.volume, 0),
      quoteVolume: bars.reduce((sum, bar) => sum + bar.quoteVolume, 0),
      tradeCount: bars.reduce((sum, bar) => sum + bar.tradeCount, 0),
      takerBuyBaseVolume: bars.reduce(
        (sum, bar) => sum + bar.takerBuyBaseVolume,
        0
      ),
      takerBuyQuoteVolume: bars.reduce(
        (sum, bar) => sum + bar.takerBuyQuoteVolume,
        0
      ),
      source: "binance_archive",
    };
    result.push({
      ...aggregated,
      ...envelopeForBar(aggregated, {
        receivedAtMs: Date.now(),
        backfilled: true,
        availabilityEstimated: true,
      }),
    });
  }
  return result.sort((left, right) => left.openTimeMs - right.openTimeMs);
}

function csvForBars(bars) {
  return [
    [
      "open_time_ms",
      "close_time_ms",
      "open",
      "high",
      "low",
      "close",
      "volume",
      "quote_volume",
      "trade_count",
      "taker_buy_base_volume",
      "taker_buy_quote_volume",
    ].join(","),
    ...bars.map((bar) =>
      [
        bar.openTimeMs,
        bar.closeTimeMs,
        bar.open,
        bar.high,
        bar.low,
        bar.close,
        bar.volume,
        bar.quoteVolume,
        bar.tradeCount,
        bar.takerBuyBaseVolume,
        bar.takerBuyQuoteVolume,
      ].join(",")
    ),
  ].join("\n");
}

async function processMonth({ symbol, month, root, store, apply }) {
  const fileName = `${symbol}USDT-1m-${month}.zip`;
  const base = `${ARCHIVE_BASE}/${symbol}USDT/1m/${fileName}`;
  const [zipBuffer, checksumBuffer] = await Promise.all([
    download(base),
    download(`${base}.CHECKSUM`),
  ]);
  if (!zipBuffer || !checksumBuffer)
    return { symbol, month, status: "unavailable" };
  const expected = parseChecksum(checksumBuffer, fileName);
  const actual = sha256(zipBuffer);
  if (expected !== actual) throw new Error(`checksum_mismatch:${fileName}`);
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
  if (entries.length !== 1)
    throw new Error(`archive_shape_invalid:${fileName}`);
  const oneMinute = parseRows(entries[0].getData().toString("utf8"), symbol);
  const fiveMinute = completeFiveMinuteBars(oneMinute);
  const archiveRelative = path.join(
    "archives",
    "binance",
    `${symbol}USDT`,
    "5m",
    `${symbol}USDT-5m-${month}.csv.gz`
  );
  const archivePath = path.join(root, archiveRelative);
  const compressed = zlib.gzipSync(csvForBars(fiveMinute), { level: 9 });
  if (apply) {
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    const temporary = `${archivePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, compressed, { mode: 0o600 });
    fs.renameSync(temporary, archivePath);
    store.upsertBars(fiveMinute);
  }
  return {
    symbol,
    month,
    status: "complete",
    sourceArchive: fileName,
    sourceSha256: actual,
    oneMinuteRows: oneMinute.length,
    fiveMinuteRows: fiveMinute.length,
    archive: archiveRelative,
    archiveSha256: sha256(compressed),
    archiveBytes: compressed.length,
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
  const symbols = option("symbols", SUPPORTED_SYMBOLS.join(","))
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter((value) => SUPPORTED_SYMBOLS.includes(value));
  const apply = process.argv.includes("--apply");
  const root = path.resolve(option("root", forecastingRoot()));
  const store = apply ? new CryptoForecastStore({ root }) : null;
  const records = [];
  try {
    for (const symbol of symbols) {
      for (const month of monthsBetween(from, to)) {
        const capacity = store?.capacity();
        if (capacity && !capacity.allowed)
          throw new Error(`capacity_guard:${capacity.reason}`);
        const record = await processMonth({
          symbol,
          month,
          root,
          store,
          apply,
        });
        records.push(record);
        process.stdout.write(`${JSON.stringify(record)}\n`);
      }
    }
    const manifest = {
      schema: "athena.crypto.forecast-dataset",
      schemaVersion: "1.0",
      generatedAt: new Date().toISOString(),
      source: "binance_public_data",
      sourceInterval: "1m",
      storedInterval: "5m",
      from,
      to,
      symbols,
      records,
    };
    const manifestSha256 = sha256(Buffer.from(JSON.stringify(manifest)));
    if (apply) {
      const manifestPath = path.join(
        root,
        "archives",
        `dataset-${manifestSha256}.json`
      );
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), {
        mode: 0o600,
      });
      store.saveDatasetManifest(manifest);
    }
    process.stdout.write(
      `${JSON.stringify({
        apply,
        manifestSha256,
        records: records.length,
        complete: records.filter(({ status }) => status === "complete").length,
      })}\n`
    );
  } finally {
    store?.close();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      error: error?.code || error?.message || "backfill_failed",
    })
  );
  process.exitCode = 1;
});
