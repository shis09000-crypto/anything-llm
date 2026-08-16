const AdmZip = require("adm-zip");
const { execFile } = require("node:child_process");
const { parse } = require("node-html-parser");
const {
  MarketDataError,
  fetchJson,
  fetchText,
} = require("../agents/aibitat/plugins/market-data/lib");
const {
  readManagedSecret,
} = require("../agents/aibitat/plugins/market-data/secrets");
const {
  CFTC_DISAGGREGATED_URL,
  FRED_CSV_BASE,
  FRED_SERIES,
  GATE_SPOT_CANDLES_URL,
  GLD_PAGE,
  GOLD_API_BASE,
  IAU_PAGE,
  SGE_BASE,
  TWELVE_DATA_BASE,
} = require("./constants");
const { resolveCotRelease } = require("./cftcReleaseCalendar");
const { marketDataEnvelope } = require("./marketDataEnvelope");

function finite(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).replace(/[,%$\s]/g, "");
  if (!normalized) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function normalizeError(error) {
  return String(error?.code || error?.name || "provider_failed")
    .toLowerCase()
    .replace(/[^a-z0-9_:-]/g, "_")
    .slice(0, 96);
}

function parseUtcDatetime(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  const parsed = Date.parse(
    /(?:z|[+-]\d\d:?\d\d)$/i.test(normalized)
      ? normalized
      : `${normalized.replace(" ", "T")}Z`
  );
  return Number.isFinite(parsed) ? parsed : null;
}

function intervalMs(interval) {
  return (
    {
      "5min": 5 * 60 * 1_000,
      "1h": 60 * 60 * 1_000,
      "1day": 24 * 60 * 60 * 1_000,
    }[interval] || null
  );
}

async function fetchTwelveSeries(
  { symbol = "XAU/USD", interval, outputsize = 5_000, now = Date.now() },
  dependencies = {}
) {
  const apiKey = dependencies.apiKey || readManagedSecret("twelveData");
  const params = new URLSearchParams({
    symbol,
    interval,
    outputsize: String(outputsize),
    order: "ASC",
    timezone: "UTC",
    apikey: apiKey,
  });
  const body = await fetchJson(
    `${TWELVE_DATA_BASE}/time_series?${params}`,
    { headers: { Accept: "application/json", "User-Agent": "Athena/1.0" } },
    dependencies.fetchImpl
  );
  if (body?.status === "error" || !Array.isArray(body?.values))
    throw new MarketDataError(
      body?.code === 429
        ? "provider_rate_limited"
        : "provider_invalid_response",
      "Twelve Data returned no usable XAU/USD time series."
    );
  const duration = intervalMs(interval);
  if (!duration)
    throw new MarketDataError("invalid_input", "Unsupported gold interval.");
  const byOpen = new Map();
  for (const value of body.values) {
    const openTimeMs = parseUtcDatetime(value.datetime);
    const open = finite(value.open);
    const high = finite(value.high);
    const low = finite(value.low);
    const close = finite(value.close);
    const volume = finite(value.volume);
    if (
      openTimeMs === null ||
      [open, high, low, close].some((item) => item === null) ||
      open <= 0 ||
      high <= 0 ||
      low <= 0 ||
      close <= 0
    )
      continue;
    const closeTimeMs = openTimeMs + duration;
    byOpen.set(openTimeMs, {
      source: "twelve_data",
      symbol,
      interval,
      openTimeMs,
      closeTimeMs,
      open,
      high,
      low,
      close,
      volume,
      backfilled: true,
      providerVersion: "twelve-data-time-series-v1",
      forming: closeTimeMs > now,
    });
  }
  const bars = [...byOpen.values()].sort(
    (left, right) => left.openTimeMs - right.openTimeMs
  );
  if (!bars.length)
    throw new MarketDataError(
      "provider_invalid_response",
      "Twelve Data returned no valid closed bars."
    );
  return {
    status: "available",
    symbol,
    interval,
    exchangeTimezone: body.meta?.exchange_timezone || "UTC",
    bars,
    receivedAtMs: now,
  };
}

async function fetchGateGoldSeries(
  { symbol = "XAU/USD", interval, outputsize = 5_000, now = Date.now() },
  dependencies = {}
) {
  if (symbol !== "XAU/USD")
    return {
      status: "optional_unavailable",
      symbol,
      interval,
      bars: [],
      receivedAtMs: now,
      reason: "gate_gold_proxy_has_no_silver_pair",
    };
  const duration = intervalMs(interval);
  if (!duration)
    throw new MarketDataError("invalid_input", "Unsupported gold interval.");
  const gateInterval = { "5min": "5m", "1day": "1d" }[interval];
  if (!gateInterval)
    throw new MarketDataError("invalid_input", "Unsupported gold interval.");
  const desired = Math.min(5_000, Math.max(30, Number(outputsize) || 30));
  const pointsPerRequest = 900;
  const end = Math.floor(now / duration) * duration;
  const ranges = [];
  for (let offset = 0; offset < desired; offset += pointsPerRequest) {
    const count = Math.min(pointsPerRequest, desired - offset);
    const toMs = end - offset * duration;
    const fromMs = toMs - (count - 1) * duration;
    ranges.push({ fromMs, toMs });
  }
  const pages = await Promise.all(
    ranges.map(({ fromMs, toMs }) => {
      const query = new URLSearchParams({
        currency_pair: "PAXG_USDT",
        interval: gateInterval,
        from: String(Math.floor(fromMs / 1_000)),
        to: String(Math.floor(toMs / 1_000)),
      });
      return fetchJson(
        `${GATE_SPOT_CANDLES_URL}?${query}`,
        { headers: { Accept: "application/json", "User-Agent": "Athena/1.0" } },
        dependencies.fetchImpl
      );
    })
  );
  const byOpen = new Map();
  for (const row of pages.flat()) {
    if (!Array.isArray(row)) continue;
    const openTimeMs = Number(row[0]) * 1_000;
    const close = finite(row[2]);
    const high = finite(row[3]);
    const low = finite(row[4]);
    const open = finite(row[5]);
    if (
      !Number.isFinite(openTimeMs) ||
      [open, high, low, close].some((value) => value === null || value <= 0)
    )
      continue;
    const closeTimeMs = openTimeMs + duration;
    byOpen.set(openTimeMs, {
      source: "gate_paxg_usdt_proxy",
      symbol,
      interval,
      openTimeMs,
      closeTimeMs,
      open,
      high,
      low,
      close,
      volume: null,
      backfilled: true,
      providerVersion: "gate-paxg-usdt-gold-proxy-v1",
      forming: closeTimeMs > now,
    });
  }
  const bars = [...byOpen.values()].sort(
    (left, right) => left.openTimeMs - right.openTimeMs
  );
  if (!bars.length)
    throw new MarketDataError(
      "provider_invalid_response",
      "Gate returned no usable PAXG/USDT gold proxy series."
    );
  return {
    status: "available",
    symbol,
    interval,
    exchangeTimezone: "UTC",
    bars,
    receivedAtMs: now,
    proxy: "PAXG/USDT",
  };
}

async function fetchGoldSeries(input, dependencies = {}) {
  try {
    return await fetchTwelveSeries(input, dependencies);
  } catch (error) {
    if (
      ![
        "provider_not_configured",
        "provider_secret_unavailable",
        "provider_unavailable",
        "provider_timeout",
        "provider_http_error",
        "provider_rate_limited",
      ].includes(error?.code)
    )
      throw error;
    return await fetchGateGoldSeries(input, dependencies);
  }
}

async function fetchGoldCrosscheck(
  { now = Date.now() } = {},
  dependencies = {}
) {
  const body = await fetchJson(
    `${GOLD_API_BASE}/XAU`,
    { headers: { Accept: "application/json", "User-Agent": "Athena/1.0" } },
    dependencies.fetchImpl
  );
  const price = finite(body?.price);
  const observedAtMs = Date.parse(body?.updatedAt);
  if (price === null || !Number.isFinite(observedAtMs))
    throw new MarketDataError(
      "provider_invalid_response",
      "Gold API returned no usable price."
    );
  return {
    status: "available",
    price,
    observedAtMs,
    receivedAtMs: now,
    envelope: marketDataEnvelope({
      source: "gold_api",
      market: "xau_usd_spot",
      eventType: "reference_price",
      observedAtMs,
      receivedAtMs: now,
      availableAtMs: observedAtMs,
      availabilityQuality: "received",
      revisionStatus: "not_revisable",
      providerVersion: "gold-api-v1",
      citationUrl: "https://api.gold-api.com",
    }),
  };
}

function latestFredRows(text, limit = 260) {
  return String(text || "")
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(","))
    .filter(
      ([date, value]) =>
        Number.isFinite(Date.parse(`${date}T00:00:00.000Z`)) &&
        finite(value) !== null
    )
    .slice(-limit)
    .map(([date, value]) => ({
      observedAtMs: Date.parse(`${date}T00:00:00.000Z`),
      value: finite(value),
    }));
}

async function fetchFredContext({ now = Date.now() } = {}, dependencies = {}) {
  const entries = await Promise.all(
    Object.entries(FRED_SERIES).map(async ([name, seriesId]) => {
      const csv = await fetchText(
        `${FRED_CSV_BASE}?id=${encodeURIComponent(seriesId)}`,
        {
          headers: { Accept: "text/csv", "User-Agent": "Athena/1.0" },
        },
        dependencies.fetchImpl
      );
      const rows = latestFredRows(csv);
      if (!rows.length)
        throw new MarketDataError(
          "provider_invalid_response",
          `FRED ${seriesId} has no observations.`
        );
      return [name, { seriesId, rows }];
    })
  );
  return {
    status: "available",
    receivedAtMs: now,
    series: Object.fromEntries(entries),
  };
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(value.trim());
      value = "";
    } else value += char;
  }
  values.push(value.trim());
  return values;
}

function easternReleaseAt(reportDate) {
  return resolveCotRelease(reportDate).availableAtMs;
}

function normalizeCotRow(fields) {
  if (
    !String(fields[0] || "").includes("GOLD - COMMODITY EXCHANGE") ||
    String(fields[3] || "").trim() !== "088691"
  )
    return null;
  const openInterest = finite(fields[7]);
  if (!openInterest || openInterest <= 0) return null;
  const reportDate = String(fields[2] || "");
  const reportAtMs = Date.parse(`${reportDate}T00:00:00.000Z`);
  const release = resolveCotRelease(reportDate);
  const producerLong = finite(fields[8]);
  const producerShort = finite(fields[9]);
  const managedLong = finite(fields[13]);
  const managedShort = finite(fields[14]);
  const managedSpreading = finite(fields[15]);
  if (
    [
      producerLong,
      producerShort,
      managedLong,
      managedShort,
      managedSpreading,
    ].some((value) => value === null)
  )
    return null;
  return {
    reportDate,
    reportAtMs,
    availableAtMs: release.availableAtMs,
    availabilityQuality: release.availabilityQuality,
    availabilityEstimated: release.availabilityEstimated,
    releaseDate: release.releaseDate,
    releaseCalendarVersion: release.calendarVersion,
    releaseReason: release.reason,
    releaseCitationUrl: release.citationUrl,
    openInterest,
    producerLong,
    producerShort,
    managedLong,
    managedShort,
    managedSpreading,
    managedNetRatio: (managedLong - managedShort) / openInterest,
    commercialNetRatio: (producerLong - producerShort) / openInterest,
    managedLongRatio: managedLong / openInterest,
    managedShortRatio: managedShort / openInterest,
    spreadingRatio: managedSpreading / openInterest,
  };
}

function cotRowsFromText(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => normalizeCotRow(parseCsvLine(line)))
    .filter(Boolean);
}

async function fetchBytes(url, fetchImpl = global.fetch) {
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/zip", "User-Agent": "Athena/1.0" },
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok)
      throw new MarketDataError(
        "provider_http_error",
        `The data provider returned HTTP ${response.status}.`
      );
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (fetchImpl !== global.fetch) throw error;
    return await fetchWithCurl(url, "application/zip");
  }
}

function fetchWithCurl(url, accept) {
  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      [
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--max-time",
        "12",
        "--proto",
        "=https",
        "--user-agent",
        "Athena/1.0",
        "--header",
        `Accept: ${accept}`,
        url,
      ],
      { encoding: "buffer", maxBuffer: 40 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(
            new MarketDataError(
              "provider_unavailable",
              "The CFTC provider could not be reached."
            )
          );
          return;
        }
        resolve(stdout);
      }
    );
  });
}

async function fetchCotContext(
  { now = Date.now(), historyYears = 3 } = {},
  dependencies = {}
) {
  const year = new Date(now).getUTCFullYear();
  const [current, ...archives] = await Promise.all([
    fetchText(
      CFTC_DISAGGREGATED_URL,
      { headers: { Accept: "text/plain", "User-Agent": "Athena/1.0" } },
      dependencies.fetchImpl
    ).catch(async (error) => {
      if (dependencies.fetchImpl) throw error;
      return (
        await fetchWithCurl(CFTC_DISAGGREGATED_URL, "text/plain")
      ).toString("utf8");
    }),
    ...Array.from({ length: historyYears }, (_, offset) =>
      fetchBytes(
        `https://www.cftc.gov/files/dea/history/fut_disagg_txt_${year - offset}.zip`,
        dependencies.fetchImpl
      ).catch(() => null)
    ),
  ]);
  const rows = cotRowsFromText(current);
  const history = archives.flatMap((archive) => {
    if (!archive) return [];
    const zip = new AdmZip(archive);
    return zip
      .getEntries()
      .filter((entry) => !entry.isDirectory && /\.txt$/i.test(entry.entryName))
      .flatMap((entry) => cotRowsFromText(entry.getData().toString("utf8")));
  });
  const byReport = new Map(
    [...history, ...rows].map((row) => [row.reportDate, row])
  );
  const all = [...byReport.values()]
    .filter((row) => row.availableAtMs <= now)
    .sort((left, right) => left.reportAtMs - right.reportAtMs);
  if (!all.length)
    throw new MarketDataError(
      "provider_invalid_response",
      "CFTC returned no released COMEX gold observations."
    );
  return { status: "available", rows: all, receivedAtMs: now };
}

function reportedNumber(value) {
  const normalized = String(value || "").trim();
  const match = normalized.match(/[-+]?\$?([\d,.]+)\s*([KMB])?/i);
  const number = finite(match?.[1]);
  if (number === null) return null;
  if (match?.[2]?.toUpperCase() === "B") return number * 1_000_000_000;
  if (match?.[2]?.toUpperCase() === "M") return number * 1_000_000;
  if (match?.[2]?.toUpperCase() === "K") return number * 1_000;
  return number;
}

function parseGldIssuer(html) {
  const root = parse(html);
  const values = {};
  const normalizedLabel = (value = "") => {
    const text = value.replace(/\s+/g, " ").trim();
    if (text.startsWith("Shares Outstanding")) return "Shares Outstanding";
    if (text.startsWith("Assets Under Management"))
      return "Assets Under Management";
    if (text === "NAV" || text.startsWith("NAV NAV")) return "NAV";
    return text;
  };
  for (const row of root.querySelectorAll("tr")) {
    const label = normalizedLabel(
      row.querySelector(".label")?.textContent || ""
    );
    const value = row
      .querySelector(".data")
      ?.textContent.replace(/\s+/g, " ")
      .trim();
    if (label && value && values[label] === undefined) values[label] = value;
  }
  const snapshot = root.querySelector("#overview");
  for (const item of snapshot?.querySelectorAll(".snapshot > div > div") ||
    []) {
    const label = normalizedLabel(
      item.querySelector(".label")?.textContent || ""
    );
    const value = item
      .querySelector(".data")
      ?.textContent.replace(/\s+/g, " ")
      .trim();
    if (label && value && values[label] === undefined) values[label] = value;
  }
  const result = {
    nav: reportedNumber(values.NAV),
    sharesOutstanding: reportedNumber(values["Shares Outstanding"]),
    assetsUnderManagement: reportedNumber(values["Assets Under Management"]),
    tonnesInTrust: null,
  };
  return {
    ...result,
    parserStatus: Object.values(result).some(Number.isFinite)
      ? "structured_fields"
      : "unavailable",
  };
}

function propertyValueFromJsonLd(root, name) {
  for (const script of root.querySelectorAll(
    'script[type="application/ld+json"]'
  )) {
    try {
      const document = JSON.parse(script.textContent);
      const queue = [document];
      while (queue.length) {
        const value = queue.pop();
        if (!value || typeof value !== "object") continue;
        if (value.name === name && value.value !== undefined)
          return value.value;
        queue.push(...Object.values(value));
      }
    } catch {
      // Ignore unrelated or malformed structured-data blocks.
    }
  }
  return null;
}

function componentDataPoints(root) {
  const points = {};
  for (const element of root.querySelectorAll(
    "walrus-render-on-client[componentprops]"
  )) {
    try {
      const document = JSON.parse(element.getAttribute("componentprops"));
      const queue = [document];
      while (queue.length) {
        const value = queue.pop();
        if (!value || typeof value !== "object") continue;
        if (
          typeof value.name === "string" &&
          value.formattedValue !== undefined &&
          points[value.name] === undefined
        )
          points[value.name] = value.formattedValue;
        queue.push(...Object.values(value));
      }
    } catch {
      // A page can contain unrelated client-component payloads.
    }
  }
  return points;
}

function parseIauIssuer(html) {
  const root = parse(html);
  const points = componentDataPoints(root);
  return {
    nav: finite(propertyValueFromJsonLd(root, "NAV as of")),
    closingPrice: finite(points.closingPrice),
    tonnesInTrust: finite(points.tonnes),
    ouncesInTrust: finite(points.ounces),
    premiumDiscountPercent: finite(
      points.premiumDiscountClosingPriceNavPercent ??
        points.premiumDiscountPercent
    ),
    dailyVolume: finite(points.consolidatedVolume),
    parserStatus:
      points.tonnes || points.closingPrice
        ? "structured_fields"
        : "unavailable",
  };
}

async function fetchEtfContext({ now = Date.now() } = {}, dependencies = {}) {
  const [gldHtml, iauHtml] = await Promise.all([
    fetchText(
      GLD_PAGE,
      {
        headers: {
          Accept: "text/html",
          "User-Agent": "Mozilla/5.0 Athena/1.0",
        },
      },
      dependencies.fetchImpl
    ),
    fetchText(
      IAU_PAGE,
      {
        headers: {
          Accept: "text/html",
          "User-Agent": "Mozilla/5.0 Athena/1.0",
        },
      },
      dependencies.fetchImpl
    ),
  ]);
  return {
    status: "available",
    receivedAtMs: now,
    gld: parseGldIssuer(gldHtml),
    iau: parseIauIssuer(iauHtml),
  };
}

function recentDateRange(now) {
  const end = new Date(now);
  const start = new Date(now - 10 * 24 * 60 * 60 * 1_000);
  const ymd = (date) => date.toISOString().slice(0, 10);
  return { start: ymd(start), end: ymd(end) };
}

function parseSgeRows(text) {
  const compact = parse(text).textContent.replace(/\s+/g, " ");
  const matches = [
    ...compact.matchAll(
      /(\d{4}-?\d{2}-?\d{2})\s+SHAU\s+(早盘|午盘)\s+\d+\s+([\d.]+)/g
    ),
  ];
  return matches
    .map((match) => ({
      date: match[1].replace(/-/g, ""),
      session: match[2] === "早盘" ? "am" : "pm",
      priceCnyPerGram: finite(match[3]),
    }))
    .filter((row) => row.priceCnyPerGram !== null);
}

async function fetchSgeContext({ now = Date.now() } = {}, dependencies = {}) {
  const { start, end } = recentDateRange(now);
  const params = new URLSearchParams({ start_date: start, end_date: end });
  const html = await fetchText(
    `${SGE_BASE}?${params}`,
    {
      headers: {
        Accept: "text/html",
        "User-Agent": "Mozilla/5.0 Athena/1.0",
      },
    },
    dependencies.fetchImpl
  );
  const rows = parseSgeRows(html);
  if (!rows.length)
    throw new MarketDataError(
      "provider_invalid_response",
      "SGE returned no Shanghai Gold benchmark rows."
    );
  return { status: "available", rows, receivedAtMs: now };
}

async function fetchUsdCny({ now = Date.now() } = {}, dependencies = {}) {
  const body = await fetchJson(
    "https://api.frankfurter.dev/v1/latest?from=USD&to=CNY",
    { headers: { Accept: "application/json", "User-Agent": "Athena/1.0" } },
    dependencies.fetchImpl
  );
  const rate = finite(body?.rates?.CNY);
  const observedAtMs = Date.parse(`${body?.date}T00:00:00.000Z`);
  if (rate === null || !Number.isFinite(observedAtMs))
    throw new MarketDataError(
      "provider_invalid_response",
      "Frankfurter returned no USD/CNY reference rate."
    );
  return {
    status: "available",
    rate,
    observedAtMs,
    receivedAtMs: now,
  };
}

module.exports = {
  cotRowsFromText,
  easternReleaseAt,
  fetchCotContext,
  fetchEtfContext,
  fetchFredContext,
  fetchGateGoldSeries,
  fetchGoldSeries,
  fetchGoldCrosscheck,
  fetchSgeContext,
  fetchTwelveSeries,
  fetchUsdCny,
  finite,
  latestFredRows,
  normalizeError,
  parseGldIssuer,
  parseIauIssuer,
  parseCsvLine,
  parseSgeRows,
  resolveCotRelease,
};
