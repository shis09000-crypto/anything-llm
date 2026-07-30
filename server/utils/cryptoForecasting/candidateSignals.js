const {
  GatePublicMarketClient,
  fetchDerivativesEvidence,
} = require("../cryptoGate");

const COIN_METRICS_BASE =
  "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics";
const DEFILLAMA_BASE = "https://api.llama.fi/v2/historicalChainTvl";
const DERIBIT_BASE = "https://www.deribit.com/api/v2";
const FRED_CSV_BASE = "https://fred.stlouisfed.org/graph/fredgraph.csv";
const COIN_METRICS = Object.freeze([
  "AdrActCnt",
  "TxCnt",
  "CapMrktCurUSD",
  "CapMVRVCur",
  "FlowInExNtv",
  "FlowOutExNtv",
  "SplyCur",
]);
const DERIBIT_CURRENCIES = Object.freeze({
  BTC: "BTC",
  ETH: "ETH",
});
const FRED_SERIES = Object.freeze({
  dxy: "DTWEXBGS",
  vix: "VIXCLS",
});
const DEFI_CHAINS = Object.freeze({
  ETH: "Ethereum",
  SOL: "Solana",
});

async function fetchJson(url, { fetchImpl = global.fetch } = {}) {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(8_000),
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    const error = new Error(`candidate_http_${response.status}`);
    error.code = `candidate_http_${response.status}`;
    throw error;
  }
  return response.json();
}

async function fetchText(url, { fetchImpl = global.fetch } = {}) {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(8_000),
    headers: { Accept: "text/csv,text/plain" },
  });
  if (!response.ok) {
    const error = new Error(`candidate_http_${response.status}`);
    error.code = `candidate_http_${response.status}`;
    throw error;
  }
  return response.text();
}

function pointInTimeMetadata({
  now,
  availabilityQuality,
  revisionStatus,
  providerVersion,
  licenseId,
  citationUrl,
}) {
  return {
    receivedAtMs: now,
    availabilityEstimated: availabilityQuality !== "exact",
    availabilityQuality,
    revisionStatus,
    providerVersion,
    licenseId,
    citationUrl,
  };
}

async function collectGateDerivatives({
  symbol,
  now = Date.now(),
  client = new GatePublicMarketClient(),
}) {
  const evidence = await fetchDerivativesEvidence({
    pair: `${symbol}_USDT`,
    client,
    now,
  });
  const observations = [];
  const statsTimestamp = Number(
    evidence.dataQuality?.newestStatsTimestampMs || evidence.asOf
  );
  if (Number.isFinite(statsTimestamp))
    observations.push({
      source: "gate_derivatives",
      symbol,
      observedAtMs: statsTimestamp,
      availableAtMs: now,
      status: "candidate_until_180d_ablation",
      payload: {
        market: evidence.market,
        openInterest: evidence.openInterest,
        positioning: evidence.positioning,
        liquidations: evidence.liquidations,
        dataQuality: evidence.dataQuality,
      },
    });
  const fundingTimestamp = Number(evidence.funding?.latestTimestampMs);
  if (
    Number.isFinite(fundingTimestamp) &&
    Number.isFinite(evidence.funding?.latestRate)
  )
    observations.push({
      source: "gate_funding",
      symbol,
      observedAtMs: fundingTimestamp,
      availableAtMs: now,
      status: "paper_cost_only_until_180d_ablation",
      payload: {
        rate: evidence.funding.latestRate,
        contract: evidence.contract,
      },
    });
  return { status: evidence.status, observations };
}

async function collectCoinMetrics({
  symbol,
  now = Date.now(),
  fetchImpl = global.fetch,
}) {
  const params = new URLSearchParams({
    assets: symbol.toLowerCase(),
    metrics: COIN_METRICS.join(","),
    frequency: "1d",
    page_size: "2",
    paging_from: "end",
  });
  const payload = await fetchJson(`${COIN_METRICS_BASE}?${params}`, {
    fetchImpl,
  });
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const row = rows.at(-1);
  const observedAtMs = Date.parse(row?.time);
  if (!row || !Number.isFinite(observedAtMs))
    return { status: "unavailable", observations: [] };
  return {
    status: "candidate",
    observations: [
      {
        source: "coinmetrics_community",
        symbol,
        observedAtMs,
        availableAtMs: now,
        status: "supporting_only_until_180d_point_in_time",
        ...pointInTimeMetadata({
          now,
          availabilityQuality: "organic_only",
          revisionStatus: "unknown",
          providerVersion: "coinmetrics-community-v4",
          licenseId: "coinmetrics-community-noncommercial",
          citationUrl: "https://docs.coinmetrics.io/api",
        }),
        payload: {
          activeAddresses: row.AdrActCnt ?? null,
          transactionCount: row.TxCnt ?? null,
          marketCapUsd: row.CapMrktCurUSD ?? null,
          mvrv: row.CapMVRVCur ?? null,
          exchangeInflowNative: row.FlowInExNtv ?? null,
          exchangeOutflowNative: row.FlowOutExNtv ?? null,
          exchangeNetflowNative:
            Number.isFinite(Number(row.FlowInExNtv)) &&
            Number.isFinite(Number(row.FlowOutExNtv))
              ? Number(row.FlowInExNtv) - Number(row.FlowOutExNtv)
              : null,
          currentSupply: row.SplyCur ?? null,
        },
      },
    ],
  };
}

async function collectDefiLlama({
  symbol,
  now = Date.now(),
  fetchImpl = global.fetch,
}) {
  const chain = DEFI_CHAINS[symbol];
  if (!chain) return { status: "not_applicable", observations: [] };
  const rows = await fetchJson(
    `${DEFILLAMA_BASE}/${encodeURIComponent(chain)}`,
    { fetchImpl }
  );
  const row = Array.isArray(rows) ? rows.at(-1) : null;
  const observedAtMs = Number(row?.date) * 1_000;
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(Number(row?.tvl)))
    return { status: "unavailable", observations: [] };
  return {
    status: "candidate",
    observations: [
      {
        source: "defillama_free",
        symbol,
        observedAtMs,
        availableAtMs: now,
        status: "candidate_pending_ablation",
        ...pointInTimeMetadata({
          now,
          availabilityQuality: "organic_only",
          revisionStatus: "unknown",
          providerVersion: "defillama-free-v2",
          licenseId: "defillama-free-api",
          citationUrl: "https://api-docs.defillama.com/",
        }),
        payload: { chain, tvlUsd: Number(row.tvl) },
      },
    ],
  };
}

async function collectDeribitDvol({
  symbol,
  now = Date.now(),
  fetchImpl = global.fetch,
}) {
  const currency = DERIBIT_CURRENCIES[symbol];
  if (!currency) return { status: "not_applicable", observations: [] };
  const params = new URLSearchParams({
    currency,
    start_timestamp: String(now - 48 * 60 * 60 * 1_000),
    end_timestamp: String(now),
    resolution: "3600",
  });
  const payload = await fetchJson(
    `${DERIBIT_BASE}/public/get_volatility_index_data?${params}`,
    { fetchImpl }
  );
  const rows = Array.isArray(payload?.result?.data) ? payload.result.data : [];
  const row = rows.at(-1);
  const observedAtMs = Number(row?.[0]);
  const values = Array.isArray(row) ? row.slice(1, 5).map(Number) : [];
  if (
    !Number.isFinite(observedAtMs) ||
    values.length !== 4 ||
    !values.every(Number.isFinite)
  )
    return { status: "unavailable", observations: [] };
  return {
    status: "candidate",
    observations: [
      {
        source: "deribit_dvol",
        symbol,
        observedAtMs,
        availableAtMs: now,
        status: "supporting_only_until_180d_ablation",
        ...pointInTimeMetadata({
          now,
          availabilityQuality: "organic_only",
          revisionStatus: "not_revisable",
          providerVersion: "deribit-public-api-v2",
          licenseId: "deribit-public-market-data",
          citationUrl: "https://docs.deribit.com/",
        }),
        payload: {
          currency,
          interval: "1h",
          open: values[0],
          high: values[1],
          low: values[2],
          close: values[3],
        },
      },
    ],
  };
}

function latestFredRow(csv) {
  const lines = String(csv || "")
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(","))
    .filter(
      ([date, value]) =>
        Number.isFinite(Date.parse(`${date}T00:00:00.000Z`)) &&
        Number.isFinite(Number(value))
    );
  const row = lines.at(-1);
  return row
    ? {
        observedAtMs: Date.parse(`${row[0]}T00:00:00.000Z`),
        value: Number(row[1]),
      }
    : null;
}

async function collectFredMacro({
  symbol,
  now = Date.now(),
  fetchImpl = global.fetch,
}) {
  const entries = await Promise.all(
    Object.entries(FRED_SERIES).map(async ([name, seriesId]) => {
      const csv = await fetchText(
        `${FRED_CSV_BASE}?id=${encodeURIComponent(seriesId)}`,
        { fetchImpl }
      );
      return [name, seriesId, latestFredRow(csv)];
    })
  );
  const observations = entries
    .filter(([, , row]) => row)
    .map(([name, seriesId, row]) => ({
      source: `fred_${name}`,
      symbol,
      observedAtMs: row.observedAtMs,
      availableAtMs: Math.max(now, row.observedAtMs + 36 * 60 * 60 * 1_000),
      status: "supporting_only_estimated_availability",
      ...pointInTimeMetadata({
        now,
        availabilityQuality: "estimated",
        revisionStatus: "unknown",
        providerVersion: "fred-csv",
        licenseId: `fred-series-${seriesId}`,
        citationUrl: `https://fred.stlouisfed.org/series/${seriesId}`,
      }),
      payload: {
        seriesId,
        value: row.value,
        conservativeAvailabilityLagMs: 36 * 60 * 60 * 1_000,
      },
    }));
  return {
    status:
      observations.length === Object.keys(FRED_SERIES).length
        ? "candidate"
        : observations.length
          ? "partial"
          : "unavailable",
    observations,
  };
}

module.exports = {
  COIN_METRICS_BASE,
  COIN_METRICS,
  DEFILLAMA_BASE,
  DEFI_CHAINS,
  DERIBIT_BASE,
  FRED_CSV_BASE,
  FRED_SERIES,
  collectCoinMetrics,
  collectDefiLlama,
  collectDeribitDvol,
  collectFredMacro,
  collectGateDerivatives,
  latestFredRow,
};
