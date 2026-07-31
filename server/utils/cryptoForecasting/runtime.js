const crypto = require("node:crypto");
const {
  HORIZONS,
  QUOTE,
  SUPPORTED_SYMBOLS,
  forecastingRoot,
} = require("./constants");
const {
  aggregateBars,
  fetchClosedDerivativeKlines,
  fetchClosedKlines,
  fetchFundingRates,
} = require("./binance");
const {
  collectCoinMetrics,
  collectDefiLlama,
  collectDeribitDvol,
  collectFredMacro,
  collectGateDerivatives,
} = require("./candidateSignals");
const { ForecastModelRuntime, resolvePaperOutcome } = require("./modelRuntime");
const { GOVERNANCE_STATES } = require("./governance");
const { BinanceMicrostructureCollector } = require("./microstructureCollector");
const {
  PUBLIC_FORECAST_MODE,
  PUBLIC_FORECAST_POLICY,
  monitoringOnlyHorizonView,
  monitoringOnlyPredictionDetails,
} = require("./publicPolicy");
const { CryptoForecastStore } = require("./store");
const {
  createAuthoritativeCryptoForecastStore,
  remoteStoreEnabled,
} = require("./authoritativeStore");
const {
  COST_MODEL,
  COST_MODEL_SHA256,
  COST_MODEL_V3,
  COST_MODEL_V3_SHA256,
  COST_MODEL_V5,
  COST_MODEL_V5_SHA256,
  FEATURE_REGISTRY,
  FEATURE_REGISTRY_SHA256,
  FEATURE_REGISTRY_V3,
  FEATURE_REGISTRY_V3_SHA256,
  FEATURE_REGISTRY_V4,
  FEATURE_REGISTRY_V4_SHA256,
  FEATURE_REGISTRY_V5,
  FEATURE_REGISTRY_V5_SHA256,
  canonicalJson,
  sha256,
} = require("./contracts");
const { emitSemanticEvent } = require("../observability/semanticEvents");
const { metrics } = require("../observability/metrics");

const LEASE_NAME = "crypto-forecasting-collector";
const LEASE_TTL_MS = 90_000;
const LOOP_INTERVAL_MS = 60_000;
const HISTORY_LIMIT = 30 * 24 * 12 + 1_000;
const MAX_CATCHUP_PAGES = 50;

function enabled(env = process.env) {
  if (env.ATHENA_CRYPTO_FORECASTING_ENABLED === "true") return true;
  if (env.ATHENA_CRYPTO_FORECASTING_ENABLED === "false") return false;
  return env.NODE_ENV === "production";
}

function microstructureEnabled(env = process.env) {
  return env.ATHENA_CRYPTO_FORECAST_MICROSTRUCTURE_ENABLED === "true";
}

function derivativeCollectionEnabled(env = process.env) {
  return env.ATHENA_CRYPTO_FORECAST_DERIVATIVES_ENABLED === "true";
}

function errorCode(error) {
  return String(error?.code || error?.name || "unknown_error")
    .toLowerCase()
    .replace(/[^a-z0-9_:-]/g, "_")
    .slice(0, 96);
}

function predictionId({ symbol, horizon, asOfMs, modelVersion }) {
  return crypto
    .createHash("sha256")
    .update(`${symbol}|${horizon}|${asOfMs}|${modelVersion}`)
    .digest("hex");
}

function encodeCursor({ asOfMs, predictionId: id }) {
  return Buffer.from(
    JSON.stringify({ v: 1, asOfMs, predictionId: id }),
    "utf8"
  ).toString("base64url");
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(String(value), "base64url").toString("utf8")
    );
    if (
      parsed?.v !== 1 ||
      !Number.isSafeInteger(parsed.asOfMs) ||
      !/^[a-f0-9]{64}$/.test(parsed.predictionId || "")
    )
      throw new Error("invalid_cursor");
    return parsed;
  } catch {
    const error = new Error("invalid_cursor");
    error.code = "invalid_cursor";
    throw error;
  }
}

function publicHorizonView(prediction) {
  if (!prediction) return null;
  const payload = prediction.payload;
  return monitoringOnlyHorizonView({
    status: prediction.status,
    abstained: true,
    abstainReasons: payload.abstainReasons,
    evidenceCoverage: payload.evidenceCoverage,
    dataFreshnessMs: payload.dataFreshnessMs,
    decisionLayer: payload.decisionLayer || null,
    labelPolicyVersion: payload.labelPolicyVersion || null,
    derivativesCoverage: payload.derivativesCoverage || null,
    metaModelArtifactSha256: payload.metaModelArtifactSha256 || null,
    selectivePolicyVersion: payload.selectivePolicyVersion || null,
    driverMethod: payload.driverMethod || null,
    featureFamilyEligibility: payload.featureFamilyEligibility || null,
    ablationReportSha256: payload.ablationReportSha256 || null,
    futureVolatility: payload.futureVolatility || null,
    marketState: payload.marketState || null,
    tailRisk: payload.tailRisk || null,
    currentRegime: payload.currentRegime || null,
    dataFamilyCoverage: payload.dataFamilyCoverage || null,
    featureSelectionVersion: payload.featureSelectionVersion || null,
    validationProtocolVersion: payload.validationProtocolVersion || null,
    prospectiveEvidence: payload.prospectiveEvidence || null,
    modelArtifactSha256: payload.modelArtifactSha256 || null,
    asOf: new Date(payload.asOfMs).toISOString(),
    outcomeDueAt: new Date(prediction.outcomeDueMs).toISOString(),
    predictionId: prediction.predictionId,
    passportRef:
      payload.passport?.schema === "athena.crypto.prediction-passport"
        ? prediction.predictionId
        : null,
    governanceState:
      payload.passport?.governance?.state ||
      (prediction.status === "active" ? "active" : "shadow"),
    costModelVersion:
      payload.passport?.costModelVersion ||
      payload.costModelVersion ||
      COST_MODEL.costModelVersion,
    resolved: Boolean(prediction.resolvedAtMs),
  });
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function microstructureWindow(rows, minutes, nowMs) {
  const selected = rows.slice(0, minutes);
  const buy = selected.reduce(
    (sum, row) => sum + Number(row.takerBuyQuote || 0),
    0
  );
  const sell = selected.reduce(
    (sum, row) => sum + Number(row.takerSellQuote || 0),
    0
  );
  const coverage = selected.length
    ? selected.reduce(
        (sum, row) => sum + Number(row.samplingCoverage || 0),
        0
      ) / selected.length
    : 0;
  const latestAvailableAtMs = selected.length
    ? Math.max(...selected.map((row) => Number(row.availableAtMs || 0)))
    : null;
  const reportedGapCount = selected.reduce(
    (sum, row) => sum + Number(row.gapCount || 0),
    0
  );
  const missingMinuteCount = selected
    .slice(1)
    .reduce(
      (count, row, index) =>
        count +
        (Number(selected[index].minuteMs) - Number(row.minuteMs) === 60_000
          ? 0
          : 1),
      0
    );
  const gapCount = reportedGapCount + missingMinuteCount;
  const status =
    selected.length >= minutes &&
    coverage >= 0.8 &&
    gapCount === 0 &&
    nowMs - latestAvailableAtMs <= 120_000
      ? "available"
      : selected.length
        ? "warming"
        : "unavailable";
  const depth = Object.fromEntries(
    ["10bps", "25bps", "50bps"].map((key) => {
      const samples = selected
        .map((row) => row.depth?.[key]?.imbalance)
        .filter(Number.isFinite);
      const bid = selected
        .map((row) => row.depth?.[key]?.bid)
        .filter(Number.isFinite);
      const ask = selected
        .map((row) => row.depth?.[key]?.ask)
        .filter(Number.isFinite);
      const average = (values) =>
        values.length
          ? values.reduce((sum, value) => sum + value, 0) / values.length
          : null;
      return [
        key,
        {
          bidMean: average(bid),
          askMean: average(ask),
          imbalanceMedian: median(samples),
          positiveSampleRatio: samples.length
            ? samples.filter((value) => value > 0).length / samples.length
            : null,
          negativeSampleRatio: samples.length
            ? samples.filter((value) => value < 0).length / samples.length
            : null,
          sampleCount: samples.length,
        },
      ];
    })
  );
  return {
    status,
    sampleCount: selected.length,
    samplingCoverage: coverage,
    latestAvailableAtMs,
    dataFreshnessMs:
      latestAvailableAtMs === null
        ? null
        : Math.max(0, nowMs - latestAvailableAtMs),
    gapCount,
    tradeCount: selected.reduce(
      (sum, row) => sum + Number(row.tradeCount || 0),
      0
    ),
    takerBuyQuote: buy,
    takerSellQuote: sell,
    takerBuyRatio: buy + sell > 0 ? buy / (buy + sell) : null,
    cumulativeVolumeDelta: buy - sell,
    depth,
  };
}

class CryptoForecastingRuntime {
  constructor({
    root = forecastingRoot(),
    store = null,
    modelRuntime = null,
    fetchKlines = fetchClosedKlines,
    fetchDerivativeKlines = fetchClosedDerivativeKlines,
    fetchDerivativeFunding = fetchFundingRates,
    candidateCollectors = {
      gate: collectGateDerivatives,
      coinMetrics: collectCoinMetrics,
      defiLlama: collectDefiLlama,
      deribit: collectDeribitDvol,
      fred: collectFredMacro,
    },
    microstructureCollector = null,
    now = () => Date.now(),
    env = process.env,
  } = {}) {
    this.root = root;
    this.store = store;
    this.modelRuntime = modelRuntime;
    this.fetchKlines = fetchKlines;
    this.fetchDerivativeKlines = fetchDerivativeKlines;
    this.fetchDerivativeFunding = fetchDerivativeFunding;
    this.candidateCollectors = candidateCollectors;
    this.microstructureCollector = microstructureCollector;
    this.now = now;
    this.env = env;
    this.ownerId = `${process.pid}:${crypto.randomUUID()}`;
    this.running = false;
    this.timer = null;
    this.inFlight = null;
    this.lastTickAt = null;
    this.lastSuccessAt = null;
    this.lastErrorCode = null;
    this.capacityState = null;
    this.lastModelLoadErrorEmitted = null;
    this.lastCandidateHour = null;
    this.lastLowFrequencyDay = null;
    this.contractsInstalled = false;
    this.initializing = null;
  }

  ensureDependencies() {
    if (!this.store) {
      if (remoteStoreEnabled(this.env)) {
        const error = new Error("crypto_forecast_store_not_initialized");
        error.code = "CRYPTO_FORECAST_STORE_NOT_INITIALIZED";
        throw error;
      }
      this.store = new CryptoForecastStore({
        root: this.root,
        env: this.env,
        now: this.now,
      });
    }
    if (!this.modelRuntime)
      this.modelRuntime = new ForecastModelRuntime({
        root: this.root,
        env: this.env,
      });
    this.installContracts();
  }

  installContracts() {
    if (this.contractsInstalled) return;
    this.store.saveFeatureRegistry({
      registrySha256: FEATURE_REGISTRY_SHA256,
      registryVersion: FEATURE_REGISTRY.registryVersion,
      registry: FEATURE_REGISTRY,
    });
    this.store.saveFeatureRegistry({
      registrySha256: FEATURE_REGISTRY_V3_SHA256,
      registryVersion: FEATURE_REGISTRY_V3.registryVersion,
      registry: FEATURE_REGISTRY_V3,
    });
    this.store.saveFeatureRegistry({
      registrySha256: FEATURE_REGISTRY_V4_SHA256,
      registryVersion: FEATURE_REGISTRY_V4.registryVersion,
      registry: FEATURE_REGISTRY_V4,
    });
    this.store.saveFeatureRegistry({
      registrySha256: FEATURE_REGISTRY_V5_SHA256,
      registryVersion: FEATURE_REGISTRY_V5.registryVersion,
      registry: FEATURE_REGISTRY_V5,
    });
    this.store.saveCostModel({
      costModelSha256: COST_MODEL_SHA256,
      costModelVersion: COST_MODEL.costModelVersion,
      costModel: COST_MODEL,
    });
    this.store.saveCostModel({
      costModelSha256: COST_MODEL_V3_SHA256,
      costModelVersion: COST_MODEL_V3.costModelVersion,
      costModel: COST_MODEL_V3,
    });
    this.store.saveCostModel({
      costModelSha256: COST_MODEL_V5_SHA256,
      costModelVersion: COST_MODEL_V5.costModelVersion,
      costModel: COST_MODEL_V5,
    });
    if (!this.microstructureCollector && microstructureEnabled(this.env))
      this.microstructureCollector = new BinanceMicrostructureCollector({
        store: this.store,
        root: this.root,
        now: this.now,
        onMetric: (action, symbol, value) =>
          metrics.cryptoForecastMicrostructureEvents.inc(
            { action, symbol },
            value
          ),
      });
    metrics.cryptoForecastContractStatus.set(
      { contract: "feature_registry" },
      1
    );
    metrics.cryptoForecastContractStatus.set({ contract: "cost_model" }, 1);
    this.contractsInstalled = true;
  }

  async initializeDependencies() {
    if (this.store) {
      this.ensureDependencies();
      return this.store;
    }
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      if (remoteStoreEnabled(this.env))
        this.store = await createAuthoritativeCryptoForecastStore({
          env: this.env,
          now: this.now,
        });
      else
        this.store = new CryptoForecastStore({
          root: this.root,
          env: this.env,
          now: this.now,
        });
      if (!this.modelRuntime)
        this.modelRuntime = new ForecastModelRuntime({
          root: this.root,
          env: this.env,
        });
      this.installContracts();
      return this.store;
    })().finally(() => {
      this.initializing = null;
    });
    return this.initializing;
  }

  start() {
    if (!enabled(this.env)) return { started: false, reason: "disabled" };
    if (this.running) return this.snapshot();
    if (remoteStoreEnabled(this.env)) return this.startAuthoritative();
    this.ensureDependencies();
    this.running = true;
    this.schedule(250);
    return { started: true, ...this.snapshot() };
  }

  async startAuthoritative() {
    if (this.running) return this.snapshot();
    await this.initializeDependencies();
    this.running = true;
    this.schedule(250);
    return { started: true, ...this.snapshot() };
  }

  schedule(delayMs = LOOP_INTERVAL_MS) {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => this.schedule(LOOP_INTERVAL_MS));
    }, delayMs);
    this.timer.unref?.();
  }

  async tick() {
    if (!this.running) return { skipped: true, reason: "stopped" };
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runTick().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async runTick() {
    await this.initializeDependencies();
    this.lastTickAt = new Date(this.now()).toISOString();
    if (
      !this.store.acquireLease({
        name: LEASE_NAME,
        ownerId: this.ownerId,
        ttlMs: LEASE_TTL_MS,
      })
    ) {
      this.microstructureCollector?.stop();
      return { skipped: true, reason: "lease_not_owned" };
    }
    const capacity = this.store.capacity();
    this.capacityState = capacity;
    metrics.cryptoForecastStoreBytes.set(capacity.storageBytes);
    if (!capacity.allowed) {
      this.microstructureCollector?.stop();
      this.lastErrorCode = capacity.reason;
      this.emit("crypto.forecast.collection_paused", {
        outcome: "degraded",
        severity: "warning",
        metadata: {
          errorCode: capacity.reason,
          storageBytes: capacity.storageBytes,
        },
      });
      return { skipped: true, reason: capacity.reason, capacity };
    }
    this.microstructureCollector?.start();
    const microstructure = this.microstructureCollector?.snapshot() || null;
    if (microstructure) {
      metrics.cryptoForecastAnomalyArchiveBytes.set(
        microstructure.anomalyArchiveBytes || 0
      );
      for (const [symbol, state] of Object.entries(microstructure.symbols)) {
        if (state.freshnessMs !== null)
          metrics.cryptoForecastMicrostructureFreshness.set(
            { symbol },
            state.freshnessMs / 1_000
          );
        metrics.cryptoForecastMicrostructureCoverage.set(
          { symbol },
          state.samplingCoverage
        );
      }
    }
    try {
      const collection = await this.collect();
      const derivatives = derivativeCollectionEnabled(this.env)
        ? await this.collectDerivatives()
        : { status: "disabled" };
      const candidates = await this.collectCandidateSignals();
      const generated = await this.generatePredictions();
      const resolved = this.resolveOutcomes();
      if (
        new Date(this.now()).getUTCHours() === 0 &&
        new Date(this.now()).getUTCMinutes() < 10
      )
        this.store.prune();
      await this.store.checkpoint?.();
      this.lastSuccessAt = new Date(this.now()).toISOString();
      this.lastErrorCode = null;
      return {
        collection,
        derivatives,
        candidates,
        microstructure,
        generated,
        resolved,
        capacity,
      };
    } catch (error) {
      this.lastErrorCode = errorCode(error);
      this.emit("crypto.forecast.collection_failed", {
        outcome: "failure",
        severity: "warning",
        metadata: { errorCode: this.lastErrorCode },
      });
      return { error: this.lastErrorCode, capacity };
    }
  }

  async collect() {
    const entries = await Promise.all(
      SUPPORTED_SYMBOLS.map(async (symbol) => [
        symbol,
        await this.collectSymbol(symbol),
      ])
    );
    return Object.fromEntries(entries);
  }

  async collectSymbol(symbol) {
    const latestOneMinute = this.store.latestBar(symbol, "1m");
    const latestFiveMinute = this.store.latestBar(symbol, "5m");
    const gap = this.store.firstGap({
      symbol,
      interval: "5m",
      fromMs: this.now() - 35 * 24 * 60 * 60 * 1_000,
      expectedIntervalMs: 5 * 60 * 1_000,
    });
    let startTime = gap
      ? gap.missingFromMs
      : latestOneMinute
        ? latestOneMinute.openTimeMs + 60_000
        : latestFiveMinute
          ? latestFiveMinute.closeTimeMs + 1
          : this.now() - 1_000 * 60_000;
    // Binance opens candles on exact UTC minute boundaries. A cold start can
    // happen at any millisecond, so normalize the cursor before comparing it
    // with the first returned candle. Otherwise the harmless sub-minute
    // offset is misclassified as a market-data gap and the empty store can
    // never bootstrap.
    startTime = Math.floor(startTime / 60_000) * 60_000;
    let collectedBars = 0;
    let collectedFiveMinuteBars = 0;
    let detectedGap = null;
    const pageLimit = Math.max(
      1,
      Math.min(
        100,
        Number(
          this.env.ATHENA_CRYPTO_FORECAST_CATCHUP_MAX_PAGES || MAX_CATCHUP_PAGES
        )
      )
    );
    try {
      for (let page = 0; page < pageLimit; page += 1) {
        if (
          !this.store.acquireLease({
            name: LEASE_NAME,
            ownerId: this.ownerId,
            ttlMs: LEASE_TTL_MS,
          })
        )
          throw Object.assign(new Error("collector_lease_lost"), {
            code: "collector_lease_lost",
          });
        const bars = await this.fetchKlines({
          symbol,
          quote: QUOTE,
          interval: "1m",
          startTime,
          limit: 1_000,
          now: this.now(),
        });
        if (!bars.length) break;
        if (bars[0].openTimeMs > startTime) {
          detectedGap = {
            missingFromMs: startTime,
            missingToMs: bars[0].openTimeMs - 60_000,
          };
          break;
        }
        this.store.upsertBars(bars);
        const aggregationSource = this.store.bars({
          symbol,
          interval: "1m",
          beforeMs: bars.at(-1).openTimeMs,
          limit: bars.length + 5,
        });
        const fiveMinute = aggregateBars(aggregationSource).filter(
          (bar) => bar.closeTimeMs < this.now()
        );
        this.store.upsertBars(fiveMinute);
        collectedBars += bars.length;
        collectedFiveMinuteBars += fiveMinute.length;
        startTime = bars.at(-1).openTimeMs + 60_000;
        if (bars.length < 1_000) break;
      }
      detectedGap =
        detectedGap ||
        this.store.firstGap({
          symbol,
          interval: "5m",
          fromMs: this.now() - 35 * 24 * 60 * 60 * 1_000,
          expectedIntervalMs: 5 * 60 * 1_000,
        });
      const latest = this.store.latestBar(symbol, "1m");
      const latestEvent =
        latest?.closeTimeMs || latestFiveMinute?.closeTimeMs || null;
      this.store.setSourceHealth({
        source: "binance",
        stream: `${symbol}${QUOTE}:1m`,
        status: detectedGap ? "degraded" : "healthy",
        lastEventMs: latestEvent,
        lastSuccessMs: this.now(),
        lastErrorCode: detectedGap ? "market_data_gap" : null,
        details: {
          bars: collectedBars,
          fiveMinuteBars: collectedFiveMinuteBars,
          catchupPages: Math.ceil(collectedBars / 1_000),
          gap: detectedGap,
        },
      });
      if (latestEvent)
        metrics.cryptoForecastCollectorLag.set(
          { symbol },
          Math.max(0, (this.now() - latestEvent) / 1_000)
        );
      return {
        bars: collectedBars,
        fiveMinuteBars: collectedFiveMinuteBars,
        gap: detectedGap,
      };
    } catch (error) {
      const code = errorCode(error);
      this.store.setSourceHealth({
        source: "binance",
        stream: `${symbol}${QUOTE}:1m`,
        status: "degraded",
        lastEventMs:
          latestOneMinute?.closeTimeMs || latestFiveMinute?.closeTimeMs || null,
        lastErrorCode: code,
      });
      return { error: code };
    }
  }

  async collectDerivatives() {
    const results = await Promise.all(
      SUPPORTED_SYMBOLS.map(async (symbol) => {
        try {
          const startTime = this.now() - 3 * 24 * 60 * 60 * 1_000;
          const [contract, mark, funding] = await Promise.all([
            this.fetchDerivativeKlines({
              symbol,
              quote: QUOTE,
              seriesType: "contract",
              interval: "5m",
              startTime,
              limit: 1_000,
              now: this.now(),
            }),
            this.fetchDerivativeKlines({
              symbol,
              quote: QUOTE,
              seriesType: "mark",
              interval: "5m",
              startTime,
              limit: 1_000,
              now: this.now(),
            }),
            this.fetchDerivativeFunding({
              symbol,
              quote: QUOTE,
              startTime,
              limit: 100,
              now: this.now(),
            }),
          ]);
          this.store.upsertDerivativeKlines([...contract, ...mark]);
          this.store.upsertFundingRates(funding);
          const latest = Math.max(
            contract.at(-1)?.closeTimeMs || 0,
            mark.at(-1)?.closeTimeMs || 0,
            funding.at(-1)?.calcTimeMs || 0
          );
          this.store.setSourceHealth({
            source: "binance_futures",
            stream: `${symbol}${QUOTE}:public`,
            status: contract.length && mark.length ? "healthy" : "degraded",
            lastEventMs: latest || null,
            lastSuccessMs: this.now(),
            lastErrorCode:
              contract.length && mark.length
                ? null
                : "derivative_market_data_incomplete",
            details: {
              contractBars: contract.length,
              markBars: mark.length,
              fundingRates: funding.length,
            },
          });
          return {
            symbol,
            status: contract.length && mark.length ? "complete" : "partial",
            contractBars: contract.length,
            markBars: mark.length,
            fundingRates: funding.length,
          };
        } catch (error) {
          const code = errorCode(error);
          this.store.setSourceHealth({
            source: "binance_futures",
            stream: `${symbol}${QUOTE}:public`,
            status: "degraded",
            lastErrorCode: code,
          });
          return { symbol, status: "unavailable", error: code };
        }
      })
    );
    return {
      status: results.every(({ status }) => status === "complete")
        ? "complete"
        : results.some(({ status }) => status !== "unavailable")
          ? "partial"
          : "unavailable",
      results,
    };
  }

  async collectCandidateSignals() {
    const now = this.now();
    const hour = Math.floor(now / (60 * 60 * 1_000));
    const day = Math.floor(now / (24 * 60 * 60 * 1_000));
    const collectHourly = this.lastCandidateHour !== hour;
    const collectDaily = this.lastLowFrequencyDay !== day;
    if (!collectHourly && !collectDaily)
      return { skipped: true, reason: "cadence_not_due" };

    const result = {};
    for (const symbol of SUPPORTED_SYMBOLS) {
      const tasks = [];
      if (collectHourly && typeof this.candidateCollectors.gate === "function")
        tasks.push(["gate", this.candidateCollectors.gate]);
      if (
        collectHourly &&
        typeof this.candidateCollectors.deribit === "function"
      )
        tasks.push(["deribit", this.candidateCollectors.deribit]);
      if (collectDaily) {
        for (const [name, collector] of [
          ["coinMetrics", this.candidateCollectors.coinMetrics],
          ["defiLlama", this.candidateCollectors.defiLlama],
          ["fred", this.candidateCollectors.fred],
        ])
          if (typeof collector === "function") tasks.push([name, collector]);
      }
      const settled = await Promise.allSettled(
        tasks.map(([, collector]) => collector({ symbol, now }))
      );
      result[symbol] = {};
      settled.forEach((entry, index) => {
        const [name] = tasks[index];
        if (entry.status === "rejected") {
          result[symbol][name] = { error: errorCode(entry.reason) };
          return;
        }
        const observations = entry.value?.observations || [];
        for (const observation of observations)
          this.store.recordCandidateObservation(observation);
        result[symbol][name] = {
          status: entry.value?.status || "unavailable",
          observations: observations.length,
        };
      });
    }
    if (collectHourly) this.lastCandidateHour = hour;
    if (collectDaily) this.lastLowFrequencyDay = day;
    return result;
  }

  async generatePredictions() {
    try {
      await this.modelRuntime.load();
      metrics.cryptoForecastModelAvailable.set(1);
      const modelState = this.modelRuntime.snapshot();
      this.store.setSourceHealth({
        source: "forecast_model",
        stream: "active",
        status: "healthy",
        lastSuccessMs: this.now(),
        details: {
          modelVersion: modelState.modelVersion,
          signatureValid: modelState.signatureValid === true,
          modelSource: modelState.modelSource,
        },
      });
      if (
        modelState.modelSource === "previous" &&
        modelState.errorCode &&
        this.lastModelLoadErrorEmitted !== modelState.errorCode
      ) {
        this.lastModelLoadErrorEmitted = modelState.errorCode;
        this.emit("crypto.forecast.model_load_failed", {
          outcome: "degraded",
          severity: "warning",
          metadata: {
            errorCode: modelState.errorCode,
            reasonCode: "retained_previous_model",
            modelVersion: modelState.modelVersion,
          },
        });
      }
    } catch (error) {
      metrics.cryptoForecastModelAvailable.set(0);
      const code = errorCode(error);
      this.store.setSourceHealth({
        source: "forecast_model",
        stream: "active",
        status: "unavailable",
        lastErrorCode: code,
      });
      return { generated: 0, error: code };
    }

    const marketBarsBySymbol = Object.fromEntries(
      SUPPORTED_SYMBOLS.map((symbol) => [
        symbol,
        this.store.bars({
          symbol,
          interval: "5m",
          limit: HISTORY_LIMIT,
        }),
      ])
    );
    const btcBars = marketBarsBySymbol.BTC;
    let generated = 0;
    for (const symbol of SUPPORTED_SYMBOLS) {
      const bars = marketBarsBySymbol[symbol];
      const latest = bars.at(-1);
      if (!latest) continue;
      for (const [horizon, config] of Object.entries(HORIZONS)) {
        const asOfMs =
          Math.floor((latest.closeTimeMs + 1) / config.anchorIntervalMs) *
            config.anchorIntervalMs -
          1;
        const existing = this.store.latestPrediction(symbol, horizon);
        if (
          existing?.asOfMs === asOfMs &&
          existing?.modelVersion ===
            this.modelRuntime.loaded.manifest.modelVersion
        )
          continue;
        const dataFreshnessMs = Math.max(0, this.now() - latest.closeTimeMs);
        const decisionAtMs = this.now();
        const startedAt = process.hrtime.bigint();
        const payload = await this.modelRuntime.forecast({
          symbol,
          horizon,
          bars,
          btcBars,
          marketBarsBySymbol,
          asOfMs,
          decisionAtMs,
          dataFreshnessMs,
        });
        metrics.cryptoForecastInferenceDuration.observe(
          { horizon, status: payload.status },
          Number(process.hrtime.bigint() - startedAt) / 1e9
        );
        const id = predictionId({
          symbol,
          horizon,
          asOfMs,
          modelVersion: payload.modelVersion,
        });
        const featureSnapshot = payload.featureSnapshot || null;
        if (featureSnapshot) {
          const featureRegistrySha256 =
            featureSnapshot.registrySha256 || FEATURE_REGISTRY_SHA256;
          const snapshotBody = {
            symbol,
            horizon,
            asOfMs,
            decisionAtMs,
            featureRegistrySha256,
            featureSchemaVersion: payload.featureSchemaVersion,
            values: featureSnapshot.values,
            vector: featureSnapshot.vector,
            missing: featureSnapshot.missing,
          };
          const featureSnapshotSha256 = sha256(canonicalJson(snapshotBody));
          this.store.saveFeatureSnapshot({
            snapshotSha256: featureSnapshotSha256,
            featureRegistrySha256,
            featureSchemaVersion: payload.featureSchemaVersion,
            vector: featureSnapshot.vector,
            metadata: {
              symbol,
              horizon,
              asOfMs,
              decisionAtMs,
              values: featureSnapshot.values,
              missing: featureSnapshot.missing,
              barsAvailable: featureSnapshot.barsAvailable,
            },
          });
          const horizonManifest =
            this.modelRuntime.loaded.manifest.horizons[horizon];
          const costModel =
            payload.costModelVersion === COST_MODEL_V5.costModelVersion
              ? {
                  value: COST_MODEL_V5,
                  sha256: COST_MODEL_V5_SHA256,
                }
              : payload.costModelVersion === COST_MODEL_V3.costModelVersion
                ? {
                    value: COST_MODEL_V3,
                    sha256: COST_MODEL_V3_SHA256,
                  }
                : { value: COST_MODEL, sha256: COST_MODEL_SHA256 };
          payload.passport = {
            schema: "athena.crypto.prediction-passport",
            schemaVersion: [
              "crypto-forecast-features-v4",
              "crypto-forecast-features-v5",
            ].includes(payload.featureSchemaVersion)
              ? "2.0"
              : "1.0",
            predictionId: id,
            symbol,
            horizon,
            decisionAtMs,
            marketDataAvailableThroughMs: latest.availableAtMs
              ? Math.min(decisionAtMs, latest.availableAtMs)
              : Math.min(decisionAtMs, latest.closeTimeMs + 1),
            asOfMs,
            outcomeDueMs: asOfMs + config.durationMs,
            modelVersion: payload.modelVersion,
            modelManifestSha256:
              this.modelRuntime.loaded.manifestSha256 || null,
            modelArtifactSha256: payload.modelArtifactSha256 || null,
            datasetManifestSha256: payload.datasetManifestSha256 || null,
            featureSchemaVersion: payload.featureSchemaVersion,
            featureRegistrySha256,
            featureSnapshotSha256,
            calibrationSha256: sha256(
              canonicalJson(horizonManifest.calibration || {})
            ),
            costModelVersion: costModel.value.costModelVersion,
            costModelSha256: costModel.sha256,
            decisionLayer: payload.decisionLayer || null,
            labelPolicyVersion: payload.labelPolicyVersion || null,
            derivativesCoverage: payload.derivativesCoverage || null,
            metaModelArtifactSha256: payload.metaModelArtifactSha256 || null,
            selectivePolicyVersion: payload.selectivePolicyVersion || null,
            driverMethod: payload.driverMethod || null,
            featureFamilyEligibility: payload.featureFamilyEligibility || null,
            dataFamilyCoverage: payload.dataFamilyCoverage || null,
            featureSelectionVersion: payload.featureSelectionVersion || null,
            validationProtocolVersion:
              payload.validationProtocolVersion || null,
            ablationReportSha256: payload.ablationReportSha256 || null,
            dataQuality: {
              evidenceCoverage: payload.evidenceCoverage,
              dataFreshnessMs,
              missingFeatures: featureSnapshot.missing,
              defaultedFeatureCount: featureSnapshot.missing.length,
              gapDetected: bars.some((bar) => bar.gapDetected),
              availabilityEstimated: bars.some(
                (bar) => bar.availabilityEstimated
              ),
              formingCandlesExcluded: true,
            },
            result: {
              probabilities: payload.probabilities,
              returnQuantiles: payload.returnQuantiles || null,
              futureVolatility: payload.futureVolatility || null,
              marketState: payload.marketState || null,
              tailRisk: payload.tailRisk || null,
              currentRegime: payload.currentRegime || null,
              candidateState: payload.candidateState,
              predictedState: payload.predictedState,
              abstained: payload.abstained,
              abstainReasons: payload.abstainReasons,
              drivers: payload.drivers,
              actionProbability: payload.actionProbability,
              tradeabilityProbability: payload.tradeabilityProbability ?? null,
              conditionalDirectionProbability:
                payload.conditionalDirectionProbability,
              conditionalSideProbability:
                payload.conditionalSideProbability || null,
              executionGate: payload.executionGate || null,
            },
            governance: {
              state: payload.status === "active" ? "active" : "shadow",
              promotionReasons: horizonManifest.promotionReasons || [],
              disableReasons: horizonManifest.disableReasons || [],
            },
            prospectiveEvidence: payload.prospectiveEvidence || null,
            riskWarnings: payload.abstainReasons || [],
          };
          metrics.cryptoForecastPassportEvents.inc({
            action: "generated",
            outcome: "success",
          });
        }
        delete payload.featureSnapshot;
        this.store.recordPrediction({
          predictionId: id,
          symbol,
          horizon,
          asOfMs,
          outcomeDueMs: asOfMs + config.durationMs,
          modelVersion: payload.modelVersion,
          featureSchemaVersion: payload.featureSchemaVersion,
          status: payload.status,
          payload,
        });
        generated += 1;
        metrics.cryptoForecastEvents.inc({
          action: payload.abstained ? "abstained" : "generated",
          symbol,
          horizon,
          status: payload.status,
        });
        this.emit(
          payload.abstained
            ? "crypto.forecast.abstained"
            : "crypto.forecast.generated",
          {
            outcome: payload.abstained ? "degraded" : "success",
            metadata: {
              symbol,
              horizon,
              forecastStatus: payload.status,
              modelVersion: payload.modelVersion,
              reasonCode: payload.abstainReasons?.[0] || null,
              dataFreshnessMs,
              evidenceCoverage: payload.evidenceCoverage,
            },
          }
        );
      }
    }
    return { generated };
  }

  resolveOutcomes() {
    let resolved = 0;
    for (const prediction of this.store.unresolvedPredictions(this.now())) {
      const entryBar = this.store.barAtOrAfter(
        prediction.symbol,
        "5m",
        prediction.asOfMs + 1
      );
      const exitBar = this.store.barAtOrBefore(
        prediction.symbol,
        "5m",
        prediction.outcomeDueMs
      );
      const shortEntryBar = this.store.derivativeKlineAtOrAfter({
        symbol: prediction.symbol,
        seriesType: "contract",
        interval: "5m",
        openTimeMs: prediction.asOfMs + 1,
      });
      const shortExitBar = this.store.derivativeKlineAtOrBefore({
        symbol: prediction.symbol,
        seriesType: "mark",
        interval: "5m",
        closeTimeMs: prediction.outcomeDueMs,
      });
      if (
        !entryBar ||
        !exitBar ||
        exitBar.closeTimeMs < prediction.outcomeDueMs - 5 * 60_000
      )
        continue;
      const funding = this.paperFundingCost(prediction);
      const outcome = resolvePaperOutcome({
        prediction,
        entryBar,
        exitBar,
        shortEntryBar,
        shortExitBar,
        fundingCostRatio: funding.costRatio,
        fundingCoverage: funding.coverage,
      });
      if (!outcome) continue;
      this.store.resolvePrediction(prediction.predictionId, outcome);
      resolved += 1;
      metrics.cryptoForecastEvents.inc({
        action: "paper_outcome_scored",
        symbol: prediction.symbol,
        horizon: prediction.horizon,
        status: prediction.status,
      });
      this.emit("crypto.forecast.paper_outcome_scored", {
        outcome: "success",
        metadata: {
          symbol: prediction.symbol,
          horizon: prediction.horizon,
          forecastStatus: prediction.status,
          modelVersion: prediction.modelVersion,
        },
      });
    }
    return { resolved };
  }

  paperFundingCost(prediction) {
    if (prediction.payload?.candidateState !== "down")
      return { costRatio: 0, coverage: 1, observations: 0, expected: 0 };
    const rows = this.store.fundingRates({
      symbol: prediction.symbol,
      fromMs: prediction.asOfMs + 1,
      toMs: prediction.outcomeDueMs,
      availableByMs: this.now(),
    });
    const expected = Math.floor(
      (prediction.outcomeDueMs - prediction.asOfMs) / (8 * 60 * 60 * 1_000)
    );
    const rates = rows
      .map(({ fundingRate }) => Number(fundingRate))
      .filter(Number.isFinite);
    return {
      // Positive public funding is paid by longs and received by the simulated
      // short, so it is represented as a negative cost.
      costRatio: -rates.reduce((sum, rate) => sum + rate, 0),
      coverage: expected > 0 ? Math.min(1, rates.length / expected) : 1,
      observations: rates.length,
      expected,
    };
  }

  latestForecasting(symbol) {
    this.ensureDependencies();
    const horizons = {};
    let latest = null;
    for (const horizon of Object.keys(HORIZONS)) {
      const prediction = this.store.latestPrediction(symbol, horizon);
      if (!prediction) continue;
      horizons[horizon] = publicHorizonView(prediction);
      if (!latest || prediction.asOfMs > latest.asOfMs) latest = prediction;
    }
    const model = this.modelRuntime.snapshot();
    if (!Object.keys(horizons).length)
      return {
        status: "unavailable",
        publicMode: PUBLIC_FORECAST_MODE,
        analysisPolicy: PUBLIC_FORECAST_POLICY,
        modelVersion: model.modelVersion,
        featureSchemaVersion: null,
        asOf: null,
        datasetManifestSha256: null,
        modelArtifactSha256: null,
        reason: model.errorCode || "forecast_not_ready",
        horizons: {},
      };
    const statuses = new Set(
      Object.keys(HORIZONS)
        .map((horizon) => this.store.latestPrediction(symbol, horizon)?.status)
        .filter(Boolean)
    );
    const topStatus = statuses.has("active")
      ? "active"
      : statuses.has("shadow")
        ? "shadow"
        : "abstained";
    return {
      status: topStatus,
      publicMode: PUBLIC_FORECAST_MODE,
      analysisPolicy: PUBLIC_FORECAST_POLICY,
      modelVersion: latest.modelVersion,
      featureSchemaVersion: latest.featureSchemaVersion,
      asOf: new Date(latest.asOfMs).toISOString(),
      datasetManifestSha256: latest.payload.datasetManifestSha256 || null,
      modelArtifactSha256: latest.payload.modelArtifactSha256 || null,
      horizons,
    };
  }

  microstructureEvidence(symbol) {
    this.ensureDependencies();
    const normalized = String(symbol || "")
      .trim()
      .toUpperCase();
    if (!SUPPORTED_SYMBOLS.includes(normalized)) {
      const error = new Error("unsupported_symbol");
      error.code = "unsupported_symbol";
      throw error;
    }
    const nowMs = this.now();
    const rows = this.store.microstructureMinutes({
      symbol: normalized,
      sinceMs: nowMs - 20 * 60_000,
      limit: 24,
    });
    const windows = Object.fromEntries(
      [1, 5, 15].map((minutes) => [
        `${minutes}m`,
        microstructureWindow(rows, minutes, nowMs),
      ])
    );
    const collectorSnapshot = this.microstructureCollector?.snapshot() || null;
    const collectorState = collectorSnapshot?.running
      ? collectorSnapshot.symbols?.[normalized] || null
      : null;
    const coverage =
      this.store
        .microstructureCoverage()
        .find((entry) => entry.symbol === normalized) || null;
    const status =
      windows["15m"].status === "available"
        ? "available"
        : rows.length
          ? "warming"
          : "unavailable";
    return {
      formulaVersion: "crypto-microstructure-evidence-v1",
      status,
      source: "binance_public_ws_minute_aggregation",
      symbol: normalized,
      role: "supporting_only",
      modelInputEligible: Boolean(coverage?.modelInputEligible),
      tradeFlow: { windows },
      orderBook: {
        synchronized: collectorState?.synchronized ?? null,
        lastUpdateId: collectorState?.lastUpdateId ?? null,
        windows,
      },
      dataQuality: {
        observedDays: coverage?.observedDays || 0,
        minuteCoverage: coverage?.minuteCoverage || 0,
        averageSamplingCoverage: coverage?.averageSamplingCoverage || 0,
        gaps: coverage?.gaps || 0,
        resyncs: coverage?.resyncs || 0,
        minimumHistoryDaysForModelInput: 180,
        maximumGapRateForModelInput: 0.005,
        minimumCoverageForModelInput: 0.95,
      },
    };
  }

  latest(symbol) {
    this.ensureDependencies();
    const normalized = String(symbol || "")
      .trim()
      .toUpperCase();
    if (!SUPPORTED_SYMBOLS.includes(normalized)) {
      const error = new Error("unsupported_symbol");
      error.code = "unsupported_symbol";
      throw error;
    }
    const forecasting = this.latestForecasting(normalized);
    return {
      symbol: normalized,
      forecasting,
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  predictions({
    symbol = null,
    horizon = null,
    before = null,
    limit = 50,
  } = {}) {
    this.ensureDependencies();
    const normalizedSymbol = symbol
      ? String(symbol).trim().toUpperCase()
      : null;
    if (normalizedSymbol && !SUPPORTED_SYMBOLS.includes(normalizedSymbol)) {
      const error = new Error("unsupported_symbol");
      error.code = "unsupported_symbol";
      throw error;
    }
    if (horizon && !HORIZONS[horizon]) {
      const error = new Error("unsupported_horizon");
      error.code = "unsupported_horizon";
      throw error;
    }
    const bounded = Math.max(1, Math.min(Number(limit) || 50, 100));
    const cursor = decodeCursor(before);
    const rows = this.store.listPredictions({
      symbol: normalizedSymbol,
      horizon,
      beforeAsOfMs: cursor?.asOfMs ?? Number.MAX_SAFE_INTEGER,
      beforePredictionId: cursor?.predictionId || null,
      limit: bounded + 1,
    });
    const hasMore = rows.length > bounded;
    const items = rows.slice(0, bounded);
    const last = items.at(-1);
    return {
      items: items.map((prediction) => ({
        ...publicHorizonView(prediction),
        symbol: prediction.symbol,
        horizon: prediction.horizon,
        passportStatus: prediction.passportStatus,
      })),
      nextCursor:
        hasMore && last
          ? encodeCursor({
              asOfMs: last.asOfMs,
              predictionId: last.predictionId,
            })
          : null,
    };
  }

  predictionDetails(id) {
    this.ensureDependencies();
    const result = this.store.predictionPassport(String(id || ""));
    metrics.cryptoForecastPassportEvents.inc({
      action: "replayed",
      outcome: result
        ? result.passportStatus === "complete"
          ? "success"
          : "legacy_partial"
        : "not_found",
    });
    return monitoringOnlyPredictionDetails(result);
  }

  governance() {
    this.ensureDependencies();
    return {
      schema: "athena.crypto.forecast-governance",
      schemaVersion: "1.0",
      featureRegistry: {
        version: FEATURE_REGISTRY.registryVersion,
        sha256: FEATURE_REGISTRY_SHA256,
        featureCount: FEATURE_REGISTRY.features.length,
        contract: FEATURE_REGISTRY.availabilityContract,
      },
      featureRegistries: {
        legacy: {
          version: FEATURE_REGISTRY.registryVersion,
          sha256: FEATURE_REGISTRY_SHA256,
          featureCount: FEATURE_REGISTRY.features.length,
        },
        optimized: {
          version: FEATURE_REGISTRY_V3.registryVersion,
          sha256: FEATURE_REGISTRY_V3_SHA256,
          horizons: Object.fromEntries(
            Object.entries(FEATURE_REGISTRY_V3.horizons).map(
              ([horizon, entry]) => [horizon, entry.features.length]
            )
          ),
          nearDuplicateSpearmanLimit:
            FEATURE_REGISTRY_V3.runtimeContract.nearDuplicateSpearmanLimit,
        },
        costAdjusted4h: {
          version: FEATURE_REGISTRY_V5.registryVersion,
          sha256: FEATURE_REGISTRY_V5_SHA256,
          horizon: "4h",
          maximumSideInputs:
            FEATURE_REGISTRY_V5.selectionContract.maximumSideInputs,
          maximumMetaInputs:
            FEATURE_REGISTRY_V5.selectionContract.maximumMetaInputs,
        },
      },
      costModel: {
        version: COST_MODEL.costModelVersion,
        sha256: COST_MODEL_SHA256,
      },
      costModels: {
        legacy: {
          version: COST_MODEL.costModelVersion,
          sha256: COST_MODEL_SHA256,
        },
        costAdjusted4h: {
          version: COST_MODEL_V5.costModelVersion,
          sha256: COST_MODEL_V5_SHA256,
        },
        optimized: {
          version: COST_MODEL_V3.costModelVersion,
          sha256: COST_MODEL_V3_SHA256,
        },
      },
      model: this.modelRuntime.snapshot(),
      governancePolicy: {
        publicMode: PUBLIC_FORECAST_MODE,
        analysisPolicy: PUBLIC_FORECAST_POLICY,
        states: GOVERNANCE_STATES,
        psiWarning: 0.2,
        psiSuspend: 0.3,
        onlineMinimumSettledSamples: 200,
        onlineMaximumEce: 0.08,
        requirePositiveBrierSkill: true,
        requirePositiveCostAdjustedExpectation: true,
        activationRequiresHumanApproval: true,
      },
      dataset: this.store.datasetSummary(),
      sourceHealth: this.store.sourceHealth(),
      candidateCoverage: this.store.candidateCoverage(),
      derivativeCoverage: this.store.derivativeCoverage(),
      microstructureCoverage: this.store.microstructureCoverage(),
      capacity: this.store.capacity(),
    };
  }

  emit(eventType, { outcome, severity = "info", metadata = {} }) {
    emitSemanticEvent({
      eventType,
      category: "crypto_forecasting",
      severity,
      outcome,
      subject: {
        type: "forecast",
        component: "crypto-forecasting",
        operation: eventType.split(".").at(-1),
      },
      impact: {
        userEffect: "market_forecast_research",
        scope: "public_market_data",
      },
      metadata,
      sensitivity: "metadata_only",
    });
  }

  snapshot() {
    return {
      enabled: enabled(this.env),
      running: this.running,
      ownerId: this.ownerId,
      lastTickAt: this.lastTickAt,
      lastSuccessAt: this.lastSuccessAt,
      lastErrorCode: this.lastErrorCode,
      capacity: this.capacityState,
      model: this.modelRuntime?.snapshot() || null,
      sourceHealth: this.store?.sourceHealth() || [],
      candidateCoverage: this.store?.candidateCoverage() || [],
      derivativeCoverage: this.store?.derivativeCoverage() || [],
      microstructure: this.microstructureCollector?.snapshot() || null,
      microstructureCoverage: this.store?.microstructureCoverage() || [],
      authoritativeStore: this.store?.authoritativeStatus?.() || {
        mode: "embedded",
        cacheDurable: true,
      },
    };
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.inFlight) await this.inFlight.catch(() => {});
    this.microstructureCollector?.stop();
    this.store?.releaseLease({ name: LEASE_NAME, ownerId: this.ownerId });
    if (this.store?.checkpoint)
      await this.store.checkpoint({ force: true }).catch(() => {});
    if (this.store?.closeAuthoritative)
      await this.store.closeAuthoritative();
    else this.store?.close();
    this.store = null;
    return this.snapshot();
  }
}

const cryptoForecastingRuntime = new CryptoForecastingRuntime();

module.exports = {
  CryptoForecastingRuntime,
  cryptoForecastingRuntime,
  enabled,
  microstructureEnabled,
  predictionId,
  decodeCursor,
  encodeCursor,
  publicHorizonView,
};
