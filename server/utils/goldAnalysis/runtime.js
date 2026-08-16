const crypto = require("node:crypto");
const { emitSemanticEvent } = require("../observability/semanticEvents");
const { metrics } = require("../observability/metrics");
const { canonicalJson, sha256 } = require("./contracts");
const { envelopeForBar, marketDataEnvelope } = require("./marketDataEnvelope");
const {
  fetchCotContext,
  fetchEtfContext,
  fetchFredContext,
  fetchGoldCrosscheck,
  fetchGoldSeries,
  fetchSgeContext,
  fetchUsdCny,
  normalizeError,
} = require("./providers");
const { buildGoldAnalysis, enforcePayloadBudget } = require("./quantAnalysis");
const {
  buildShadowResearch,
  publicShadowResearch,
} = require("./shadowResearch");
const { GoldAnalysisStore } = require("./store");

const CACHE_TTL_MS = 10 * 60 * 1_000;
const REFRESH_INTERVAL_MS = 60 * 60 * 1_000;
const START_DELAY_MS = 5_000;
const SOURCE_TIMEOUT_MS = 20_000;

const SOURCE_NAMES = Object.freeze([
  "twelve_data",
  "gold_api",
  "fred",
  "cftc",
  "etf_issuers",
  "sge",
  "usd_cny",
]);

function boundedFailure(source, error) {
  return {
    source,
    errorCode: normalizeError(error),
    retryable: ![
      "invalid_input",
      "secret_not_declared",
      "provider_not_configured",
      "provider_secret_unavailable",
    ].includes(normalizeError(error)),
  };
}

function boundedSourceTask(task, timeoutMs = SOURCE_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    Promise.resolve().then(task),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error("Gold analysis source timed out.");
        error.code = "provider_timeout";
        reject(error);
      }, timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function observationRows(data = {}) {
  const rows = [];
  for (const collection of [
    data.xau5m?.bars || [],
    data.xauDaily?.bars || [],
    data.xagDaily?.bars || [],
  ]) {
    for (const bar of collection) {
      if (bar.forming) continue;
      rows.push({
        envelope: envelopeForBar(bar, data.collectedAtMs),
        payload: {
          interval: bar.interval,
          symbol: bar.symbol,
          providerVersion: bar.providerVersion,
          openTimeMs: bar.openTimeMs,
          closeTimeMs: bar.closeTimeMs,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
        },
      });
    }
  }
  if (data.gold?.envelope)
    rows.push({
      envelope: data.gold.envelope,
      payload: { price: data.gold.price },
    });
  for (const [name, series] of Object.entries(data.fred?.series || {})) {
    for (const item of series.rows || []) {
      const envelope = marketDataEnvelope({
        source: "fred",
        market: series.seriesId,
        eventType: "macro_observation",
        observedAtMs: item.observedAtMs,
        receivedAtMs: data.collectedAtMs,
        availableAtMs: item.observedAtMs + 24 * 60 * 60 * 1_000,
        availabilityQuality: "estimated",
        revisionStatus: "revisable",
        backfilled: true,
        providerVersion: `fred-${name}-v1`,
        citationUrl:
          "https://fred.stlouisfed.org/docs/api/fred/series_observations.html",
      });
      rows.push({ envelope, payload: { value: item.value } });
    }
  }
  for (const item of data.cot?.rows || []) {
    const envelope = marketDataEnvelope({
      source: "cftc",
      market: "comex_gold",
      eventType: "cot_disaggregated",
      observedAtMs: item.reportAtMs,
      receivedAtMs: data.collectedAtMs,
      availableAtMs: item.availableAtMs,
      availabilityQuality: item.availabilityQuality || "estimated",
      revisionStatus: "not_revisable",
      backfilled: true,
      providerVersion: "cftc-disaggregated-v2",
      citationUrl:
        item.releaseCitationUrl ||
        "https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm",
    });
    rows.push({
      envelope,
      payload: {
        openInterest: item.openInterest,
        managedNetRatio: item.managedNetRatio,
        commercialNetRatio: item.commercialNetRatio,
        spreadingRatio: item.spreadingRatio,
        availabilityQuality: item.availabilityQuality || "estimated",
        releaseCalendarVersion: item.releaseCalendarVersion || null,
      },
    });
  }
  return rows;
}

class GoldAnalysisRuntime {
  constructor({
    store = null,
    now = () => Date.now(),
    providers = {},
    cacheTtlMs = CACHE_TTL_MS,
  } = {}) {
    this.now = now;
    this.store = store;
    this.providers = {
      twelve: providers.twelve || fetchGoldSeries,
      gold: providers.gold || fetchGoldCrosscheck,
      fred: providers.fred || fetchFredContext,
      cot: providers.cot || fetchCotContext,
      etf: providers.etf || fetchEtfContext,
      sge: providers.sge || fetchSgeContext,
      usdCny: providers.usdCny || fetchUsdCny,
    };
    this.cacheTtlMs = cacheTtlMs;
    this.cache = null;
    this.inFlight = null;
    this.refreshTimer = null;
    this.startTimer = null;
    this.started = false;
  }

  ensureStore() {
    if (!this.store) this.store = new GoldAnalysisStore();
    return this.store;
  }

  async collectSource(source, task, data, failures) {
    try {
      const value = await boundedSourceTask(task);
      if (value === null || value === undefined) {
        const error = new Error("Gold analysis source returned no value.");
        error.code = "provider_invalid_response";
        throw error;
      }
      data.sourceStatuses[source] = "available";
      this.ensureStore().setSourceHealth(source, "available");
      metrics.goldAnalysisSourceAvailable.set({ source }, 1);
      return value;
    } catch (error) {
      const failure = boundedFailure(source, error);
      failures.push(failure);
      data.sourceStatuses[source] =
        failure.errorCode === "provider_not_configured"
          ? "not_configured"
          : "unavailable";
      this.ensureStore().setSourceHealth(
        source,
        data.sourceStatuses[source],
        failure.errorCode
      );
      metrics.goldAnalysisSourceAvailable.set({ source }, 0);
      return null;
    }
  }

  async collect(dependencies = {}) {
    const now = this.now();
    const data = {
      collectedAtMs: now,
      sourceStatuses: Object.fromEntries(
        SOURCE_NAMES.map((source) => [source, "unavailable"])
      ),
    };
    const failures = [];
    const tasks = {
      xau5m: this.collectSource(
        "twelve_data",
        () =>
          this.providers.twelve(
            { symbol: "XAU/USD", interval: "5min", outputsize: 5_000, now },
            dependencies
          ),
        data,
        failures
      ),
      xauDaily: this.collectSource(
        "twelve_data",
        () =>
          this.providers.twelve(
            { symbol: "XAU/USD", interval: "1day", outputsize: 5_000, now },
            dependencies
          ),
        data,
        failures
      ),
      xagDaily: this.collectSource(
        "twelve_data",
        () =>
          this.providers.twelve(
            { symbol: "XAG/USD", interval: "1day", outputsize: 400, now },
            dependencies
          ),
        data,
        failures
      ),
      gold: this.collectSource(
        "gold_api",
        () => this.providers.gold({ now }, dependencies),
        data,
        failures
      ),
      fred: this.collectSource(
        "fred",
        () => this.providers.fred({ now }, dependencies),
        data,
        failures
      ),
      cot: this.collectSource(
        "cftc",
        () => this.providers.cot({ now }, dependencies),
        data,
        failures
      ),
      etf: this.collectSource(
        "etf_issuers",
        () => this.providers.etf({ now }, dependencies),
        data,
        failures
      ),
      sge: this.collectSource(
        "sge",
        () => this.providers.sge({ now }, dependencies),
        data,
        failures
      ),
      usdCny: this.collectSource(
        "usd_cny",
        () => this.providers.usdCny({ now }, dependencies),
        data,
        failures
      ),
    };
    const values = await Promise.all(
      Object.entries(tasks).map(async ([key, task]) => [key, await task])
    );
    Object.assign(data, Object.fromEntries(values));
    if (data.xagDaily?.status === "optional_unavailable")
      data.sourceStatuses.silver_series = "unavailable_optional";
    data.sourceStatuses.twelve_data = [data.xau5m, data.xauDaily].some(Boolean)
      ? [data.xau5m, data.xauDaily].every(Boolean)
        ? [data.xau5m, data.xauDaily].some((series) =>
            series?.bars?.some((bar) => bar.source === "gate_paxg_usdt_proxy")
          )
          ? "fallback_available"
          : "available"
        : "degraded"
      : data.sourceStatuses.twelve_data;
    metrics.goldAnalysisSourceAvailable.set(
      { source: "twelve_data" },
      ["available", "fallback_available"].includes(
        data.sourceStatuses.twelve_data
      )
        ? 1
        : 0
    );
    for (const failure of new Map(
      failures.map((item) => [`${item.source}:${item.errorCode}`, item])
    ).values()) {
      emitSemanticEvent({
        eventType: "gold.analysis.source_degraded",
        category: "agent_tool",
        severity: "warning",
        outcome: "degraded",
        subject: {
          type: "provider",
          component: failure.source,
          operation: "collect",
        },
        impact: { userEffect: "gold_analysis_partial" },
        metadata: {
          provider: failure.source,
          errorCode: failure.errorCode,
        },
      });
    }
    return { data, failures };
  }

  finalizeResult(base, shadow) {
    const result = enforcePayloadBudget({
      ...base,
      shadowResearch: publicShadowResearch(shadow),
      provenance: {
        ...base.provenance,
        runId: crypto.randomUUID(),
        hashContract:
          "sha256(canonical_json(result_without_resultSha256_and_payloadBytes))",
      },
    });
    delete result.provenance.resultSha256;
    delete result.provenance.payloadBytes;
    result.provenance.resultSha256 = sha256(result);
    result.provenance.payloadBytes = Buffer.byteLength(canonicalJson(result));
    return result;
  }

  async analyze({ force = false, dependencies = {} } = {}) {
    const now = this.now();
    if (
      !force &&
      this.cache &&
      now - this.cache.generatedAtMs < this.cacheTtlMs
    )
      return this.cache.result;
    if (!force && this.inFlight) return this.inFlight;
    const startedAt = Date.now();
    this.inFlight = (async () => {
      const store = this.ensureStore();
      const previous = store.latestSnapshot(Infinity)?.payload || null;
      const { data, failures } = await this.collect(dependencies);
      try {
        store.saveObservations(observationRows(data));
        const mergeBars = (live = [], persisted = []) => {
          const byOpen = new Map(
            [...persisted, ...live].map((bar) => [bar.openTimeMs, bar])
          );
          return [...byOpen.values()].sort(
            (left, right) => left.openTimeMs - right.openTimeMs
          );
        };
        if (data.xau5m)
          data.xau5m.bars = mergeBars(
            data.xau5m.bars,
            store.recentBars({
              symbol: "XAU/USD",
              interval: "5min",
              limit: 15_000,
            })
          );
        if (data.xauDaily)
          data.xauDaily.bars = mergeBars(
            data.xauDaily.bars,
            store.recentBars({
              symbol: "XAU/USD",
              interval: "1day",
              limit: 5_000,
            })
          );
        if (data.xagDaily)
          data.xagDaily.bars = mergeBars(
            data.xagDaily.bars,
            store.recentBars({
              symbol: "XAG/USD",
              interval: "1day",
              limit: 1_000,
            })
          );
      } catch (error) {
        failures.push(boundedFailure("gold_store", error));
      }
      const uniqueFailures = [
        ...new Map(
          failures.map((failure) => [
            `${failure.source}:${failure.errorCode}`,
            failure,
          ])
        ).values(),
      ];
      const base = buildGoldAnalysis({
        data,
        partialFailures: uniqueFailures,
        previousSnapshot: previous,
        now,
      });
      const shadow = buildShadowResearch({
        datasetSha256: base.provenance.datasetManifestSha256,
        timeframes: base.timeframes,
        volatilityRisk: base.volatilityRisk,
        now,
      });
      const result = this.finalizeResult(base, shadow);
      let stored = false;
      try {
        stored = store.saveSnapshot({
          resultSha256: result.provenance.resultSha256,
          asOfMs: now,
          status: result.analysisStatus,
          payload: result,
        });
        store.saveShadowResearch({
          researchId: shadow.researchId,
          asOfMs: now,
          datasetSha256: shadow.datasetSha256,
          registrySha256: shadow.factorRegistrySha256,
          status: shadow.status,
          payload: shadow,
        });
        const stats = store.stats();
        metrics.goldAnalysisStoreBytes.set(stats.bytes);
      } catch (error) {
        uniqueFailures.push(boundedFailure("gold_store", error));
      }
      const outcome =
        result.analysisStatus === "complete"
          ? "complete"
          : result.analysisStatus === "partial"
            ? "partial"
            : "unavailable";
      metrics.goldAnalysisRuns.inc({ outcome });
      metrics.goldAnalysisDuration.observe(
        { outcome },
        (Date.now() - startedAt) / 1_000
      );
      metrics.goldAnalysisShadowEvents.inc({
        action: "generated",
        status: shadow.status,
      });
      emitSemanticEvent({
        eventType: "gold.analysis.shadow_generated",
        category: "model_governance",
        severity: "info",
        outcome: "abstained",
        subject: {
          type: "model",
          component: "gold-shadow-research-v1",
          operation: "generate",
        },
        impact: { userEffect: "public_direction_withheld" },
        metadata: {
          forecastStatus: shadow.status,
          datasetManifestSha256: shadow.datasetSha256,
          modelArtifactSha256:
            shadow.modelSignature?.artifactSha256 || "unavailable",
          validationStatus: shadow.modelSignature?.status || "unavailable",
          reasonCode: "public_direction_disabled",
        },
      });
      emitSemanticEvent({
        eventType: "gold.analysis.completed",
        category: "agent_tool",
        severity: outcome === "unavailable" ? "warning" : "info",
        outcome,
        subject: {
          type: "tool",
          component: "gold_market_analysis",
          operation: "analyze",
        },
        impact: {
          userEffect:
            outcome === "complete"
              ? "gold_analysis_available"
              : "gold_analysis_degraded",
        },
        metadata: {
          durationMs: Date.now() - startedAt,
          resultSha256: result.provenance.resultSha256,
          stored: String(stored),
          resultSize: result.provenance.payloadBytes,
          validationStatus: result.dataQuality.status,
          reasonCode:
            failures.find(
              (failure) => failure.errorCode === "provider_not_configured"
            )?.errorCode || "none",
        },
      });
      this.cache = { generatedAtMs: now, result };
      return result;
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  start() {
    if (this.started) return { started: true, alreadyRunning: true };
    this.started = true;
    if (
      String(
        process.env.ATHENA_GOLD_ANALYSIS_BACKGROUND_ENABLED || "true"
      ).toLowerCase() === "false"
    )
      return { started: false, reason: "background_disabled" };
    this.startTimer = setTimeout(() => {
      void this.analyze().catch((error) =>
        console.warn("[GoldAnalysis] initial refresh deferred", {
          code: normalizeError(error),
        })
      );
    }, START_DELAY_MS);
    this.startTimer.unref?.();
    this.refreshTimer = setInterval(() => {
      void this.analyze({ force: true }).catch((error) =>
        console.warn("[GoldAnalysis] scheduled refresh failed", {
          code: normalizeError(error),
        })
      );
    }, REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
    return { started: true };
  }

  async stop() {
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.inFlight) await this.inFlight.catch(() => null);
    this.store?.close();
    this.store = null;
    this.started = false;
    return { stopped: true };
  }
}

const goldAnalysisRuntime = new GoldAnalysisRuntime();

module.exports = {
  CACHE_TTL_MS,
  GoldAnalysisRuntime,
  REFRESH_INTERVAL_MS,
  SOURCE_TIMEOUT_MS,
  goldAnalysisRuntime,
  observationRows,
};
