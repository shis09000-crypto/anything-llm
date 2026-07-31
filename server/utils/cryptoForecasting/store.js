const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const {
  isPostgresql,
} = require("../database/databaseProvider");
const {
  MAX_STORE_BYTES,
  MIN_FREE_BYTES,
  ONE_MINUTE_RETENTION_MS,
  forecastingRoot,
} = require("./constants");

function assertEmbeddedSqliteStoreAllowed(
  env = process.env,
  { persistenceMode = "embedded", root = forecastingRoot() } = {}
) {
  const topology = String(env.ATHENA_RUNTIME_TOPOLOGY || "")
    .trim()
    .toLowerCase();
  const authoritativeRemoteCache =
    persistenceMode === "remote-cache" &&
    String(env.ATHENA_CRYPTO_FORECAST_STORE || "").toLowerCase() ===
      "postgres-s3" &&
    path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`);
  if (
    isPostgresql(env) ||
    topology === "distributed" ||
    topology === "micro-modules"
  ) {
    if (authoritativeRemoteCache) return;
    const error = new Error(
      "crypto_forecast_embedded_sqlite_forbidden_in_authoritative_topology"
    );
    error.code = "CRYPTO_FORECAST_EMBEDDED_SQLITE_FORBIDDEN";
    throw error;
  }
}

function directorySize(root) {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) total += fs.statSync(target).size;
    }
  }
  return total;
}

function diskFreeBytes(root) {
  const stat = fs.statfsSync(root);
  return Number(stat.bavail) * Number(stat.bsize);
}

function rowToBar(row) {
  if (!row) return null;
  const availabilityEstimated =
    row.availability_estimated === null ||
    row.availability_estimated === undefined
      ? true
      : Boolean(row.availability_estimated);
  return {
    symbol: row.symbol,
    interval: row.interval,
    openTimeMs: row.open_time_ms,
    closeTimeMs: row.close_time_ms,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    quoteVolume: row.quote_volume,
    tradeCount: row.trade_count,
    takerBuyBaseVolume: row.taker_buy_base_volume,
    takerBuyQuoteVolume: row.taker_buy_quote_volume,
    source: row.source,
    eventId: row.event_id || null,
    receivedAtMs: row.received_at_ms || row.collected_at_ms,
    availableAtMs:
      row.available_at_ms ??
      (availabilityEstimated ? row.close_time_ms + 1 : row.collected_at_ms),
    backfilled:
      row.backfilled === null || row.backfilled === undefined
        ? true
        : Boolean(row.backfilled),
    availabilityEstimated,
    deduplicated: Boolean(row.deduplicated),
    gapDetected: Boolean(row.gap_detected),
    formingCandleExcluded:
      row.forming_candle_excluded === null ||
      row.forming_candle_excluded === undefined
        ? true
        : Boolean(row.forming_candle_excluded),
    availabilityQuality:
      row.availability_quality ||
      (availabilityEstimated ? "estimated" : "exact"),
    revisionStatus: row.revision_status || "not_revisable",
    providerVersion: row.provider_version || null,
    licenseId: row.license_id || null,
    citationUrl: row.citation_url || null,
  };
}

class CryptoForecastStore {
  constructor({
    root = forecastingRoot(),
    now = () => Date.now(),
    env = process.env,
    persistenceMode = "embedded",
  } = {}) {
    assertEmbeddedSqliteStoreAllowed(env, { persistenceMode, root });
    this.root = path.resolve(root);
    this.now = now;
    this.persistenceMode = persistenceMode;
    fs.mkdirSync(this.root, { recursive: true });
    fs.mkdirSync(path.join(this.root, "archives"), { recursive: true });
    fs.mkdirSync(path.join(this.root, "models"), { recursive: true });
    fs.mkdirSync(path.join(this.root, "reports"), { recursive: true });
    fs.mkdirSync(path.join(this.root, "tmp"), { recursive: true });
    this.databasePath = path.join(this.root, "online-features.db");
    this.db = new Database(this.databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
    this.prepare();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS market_bars (
        symbol TEXT NOT NULL,
        interval TEXT NOT NULL,
        open_time_ms INTEGER NOT NULL,
        close_time_ms INTEGER NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL NOT NULL,
        quote_volume REAL NOT NULL,
        trade_count INTEGER NOT NULL,
        taker_buy_base_volume REAL NOT NULL,
        taker_buy_quote_volume REAL NOT NULL,
        source TEXT NOT NULL,
        collected_at_ms INTEGER NOT NULL,
        PRIMARY KEY (symbol, interval, open_time_ms)
      );
      CREATE INDEX IF NOT EXISTS market_bars_lookup
        ON market_bars(symbol, interval, open_time_ms DESC);

      CREATE TABLE IF NOT EXISTS source_health (
        source TEXT NOT NULL,
        stream TEXT NOT NULL,
        status TEXT NOT NULL,
        last_event_ms INTEGER,
        last_success_ms INTEGER,
        last_error_code TEXT,
        details_json TEXT,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (source, stream)
      );

      CREATE TABLE IF NOT EXISTS runtime_leases (
        name TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS predictions (
        prediction_id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        horizon TEXT NOT NULL,
        as_of_ms INTEGER NOT NULL,
        outcome_due_ms INTEGER NOT NULL,
        model_version TEXT NOT NULL,
        feature_schema_version TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        resolved_at_ms INTEGER,
        outcome_json TEXT,
        UNIQUE(symbol, horizon, as_of_ms, model_version)
      );
      CREATE INDEX IF NOT EXISTS predictions_latest
        ON predictions(symbol, horizon, as_of_ms DESC);
      CREATE INDEX IF NOT EXISTS predictions_unresolved
        ON predictions(resolved_at_ms, outcome_due_ms);

      CREATE TABLE IF NOT EXISTS dataset_manifests (
        manifest_sha256 TEXT PRIMARY KEY,
        manifest_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS candidate_observations (
        source TEXT NOT NULL,
        symbol TEXT NOT NULL,
        observed_at_ms INTEGER NOT NULL,
        available_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (source, symbol, observed_at_ms)
      );
      CREATE INDEX IF NOT EXISTS candidate_observations_lookup
        ON candidate_observations(source, symbol, observed_at_ms DESC);

      CREATE TABLE IF NOT EXISTS feature_registries (
        registry_sha256 TEXT PRIMARY KEY,
        registry_version TEXT NOT NULL,
        registry_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS feature_snapshots (
        snapshot_sha256 TEXT PRIMARY KEY,
        feature_registry_sha256 TEXT NOT NULL,
        feature_schema_version TEXT NOT NULL,
        vector_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cost_models (
        cost_model_sha256 TEXT PRIMARY KEY,
        cost_model_version TEXT NOT NULL,
        cost_model_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS microstructure_minutes (
        symbol TEXT NOT NULL,
        minute_ms INTEGER NOT NULL,
        source TEXT NOT NULL,
        taker_buy_quote REAL NOT NULL,
        taker_sell_quote REAL NOT NULL,
        trade_count INTEGER NOT NULL,
        cumulative_volume_delta REAL NOT NULL,
        trade_velocity REAL NOT NULL,
        spread_bps_mean REAL,
        spread_bps_p95 REAL,
        microprice_offset_bps_mean REAL,
        bid_depth_10bps REAL,
        ask_depth_10bps REAL,
        imbalance_10bps REAL,
        bid_depth_25bps REAL,
        ask_depth_25bps REAL,
        imbalance_25bps REAL,
        bid_depth_50bps REAL,
        ask_depth_50bps REAL,
        imbalance_50bps REAL,
        gap_count INTEGER NOT NULL,
        resync_count INTEGER NOT NULL,
        sampling_coverage REAL NOT NULL,
        available_at_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (symbol, minute_ms)
      );
      CREATE INDEX IF NOT EXISTS microstructure_minutes_lookup
        ON microstructure_minutes(symbol, minute_ms DESC);

      CREATE TABLE IF NOT EXISTS derivative_klines (
        symbol TEXT NOT NULL,
        series_type TEXT NOT NULL,
        interval TEXT NOT NULL,
        open_time_ms INTEGER NOT NULL,
        close_time_ms INTEGER NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        source TEXT NOT NULL,
        available_at_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (symbol, series_type, interval, open_time_ms)
      );
      CREATE INDEX IF NOT EXISTS derivative_klines_lookup
        ON derivative_klines(symbol, series_type, interval, open_time_ms DESC);

      CREATE TABLE IF NOT EXISTS derivative_funding_rates (
        symbol TEXT NOT NULL,
        calc_time_ms INTEGER NOT NULL,
        funding_interval_hours REAL,
        funding_rate REAL NOT NULL,
        source TEXT NOT NULL,
        available_at_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (symbol, calc_time_ms)
      );
      CREATE INDEX IF NOT EXISTS derivative_funding_lookup
        ON derivative_funding_rates(symbol, calc_time_ms DESC);

      CREATE TABLE IF NOT EXISTS derivative_metrics (
        symbol TEXT NOT NULL,
        create_time_ms INTEGER NOT NULL,
        sum_open_interest REAL,
        sum_open_interest_value REAL,
        count_toptrader_long_short_ratio REAL,
        sum_toptrader_long_short_ratio REAL,
        count_long_short_ratio REAL,
        sum_taker_long_short_vol_ratio REAL,
        source TEXT NOT NULL,
        available_at_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (symbol, create_time_ms)
      );
      CREATE INDEX IF NOT EXISTS derivative_metrics_lookup
        ON derivative_metrics(symbol, create_time_ms DESC);
    `);
    this.ensureColumn("market_bars", "event_id", "TEXT");
    this.ensureColumn("market_bars", "received_at_ms", "INTEGER");
    this.ensureColumn("market_bars", "available_at_ms", "INTEGER");
    this.ensureColumn("market_bars", "backfilled", "INTEGER");
    this.ensureColumn("market_bars", "availability_estimated", "INTEGER");
    this.ensureColumn("market_bars", "deduplicated", "INTEGER");
    this.ensureColumn("market_bars", "gap_detected", "INTEGER");
    this.ensureColumn("market_bars", "forming_candle_excluded", "INTEGER");
    this.ensureColumn("market_bars", "availability_quality", "TEXT");
    this.ensureColumn("market_bars", "revision_status", "TEXT");
    this.ensureColumn("market_bars", "provider_version", "TEXT");
    this.ensureColumn("market_bars", "license_id", "TEXT");
    this.ensureColumn("market_bars", "citation_url", "TEXT");
    this.ensureColumn("candidate_observations", "received_at_ms", "INTEGER");
    this.ensureColumn(
      "candidate_observations",
      "availability_estimated",
      "INTEGER"
    );
    this.ensureColumn("candidate_observations", "availability_quality", "TEXT");
    this.ensureColumn("candidate_observations", "revision_status", "TEXT");
    this.ensureColumn("candidate_observations", "provider_version", "TEXT");
    this.ensureColumn("candidate_observations", "license_id", "TEXT");
    this.ensureColumn("candidate_observations", "citation_url", "TEXT");
    this.ensureColumn("candidate_observations", "event_id", "TEXT");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS market_bars_available
        ON market_bars(symbol, interval, available_at_ms, open_time_ms DESC);
    `);
  }

  ensureColumn(table, column, definition) {
    const columns = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((entry) => entry.name);
    if (!columns.includes(column))
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  prepare() {
    this.upsertBarStatement = this.db.prepare(`
      INSERT INTO market_bars (
        symbol, interval, open_time_ms, close_time_ms, open, high, low, close,
        volume, quote_volume, trade_count, taker_buy_base_volume,
        taker_buy_quote_volume, source, collected_at_ms, event_id,
        received_at_ms, available_at_ms, backfilled, availability_estimated,
        deduplicated, gap_detected, forming_candle_excluded,
        availability_quality, revision_status, provider_version, license_id,
        citation_url
      ) VALUES (
        @symbol, @interval, @openTimeMs, @closeTimeMs, @open, @high, @low,
        @close, @volume, @quoteVolume, @tradeCount, @takerBuyBaseVolume,
        @takerBuyQuoteVolume, @source, @collectedAtMs, @eventId,
        @receivedAtMs, @availableAtMs, @backfilled, @availabilityEstimated,
        @deduplicated, @gapDetected, @formingCandleExcluded,
        @availabilityQuality, @revisionStatus, @providerVersion, @licenseId,
        @citationUrl
      )
      ON CONFLICT(symbol, interval, open_time_ms) DO UPDATE SET
        close_time_ms = excluded.close_time_ms,
        open = excluded.open,
        high = excluded.high,
        low = excluded.low,
        close = excluded.close,
        volume = excluded.volume,
        quote_volume = excluded.quote_volume,
        trade_count = excluded.trade_count,
        taker_buy_base_volume = excluded.taker_buy_base_volume,
        taker_buy_quote_volume = excluded.taker_buy_quote_volume,
        source = excluded.source,
        collected_at_ms = excluded.collected_at_ms,
        event_id = COALESCE(excluded.event_id, market_bars.event_id),
        received_at_ms = MIN(
          COALESCE(market_bars.received_at_ms, excluded.received_at_ms),
          excluded.received_at_ms
        ),
        available_at_ms = MIN(
          COALESCE(market_bars.available_at_ms, excluded.available_at_ms),
          excluded.available_at_ms
        ),
        backfilled = excluded.backfilled,
        availability_estimated = excluded.availability_estimated,
        deduplicated = 1,
        gap_detected = MAX(
          COALESCE(market_bars.gap_detected, 0),
          excluded.gap_detected
        ),
        forming_candle_excluded = excluded.forming_candle_excluded
        ,availability_quality = excluded.availability_quality
        ,revision_status = excluded.revision_status
        ,provider_version = excluded.provider_version
        ,license_id = excluded.license_id
        ,citation_url = excluded.citation_url
    `);
    this.upsertBarsTransaction = this.db.transaction((bars) => {
      const collectedAtMs = this.now();
      for (const bar of bars) {
        const availabilityEstimated =
          bar.availabilityEstimated === undefined
            ? true
            : Boolean(bar.availabilityEstimated);
        const receivedAtMs = Number(bar.receivedAtMs ?? collectedAtMs);
        this.upsertBarStatement.run({
          ...bar,
          collectedAtMs,
          eventId: bar.eventId || null,
          receivedAtMs,
          availableAtMs: Number(
            bar.availableAtMs ??
              (availabilityEstimated ? bar.closeTimeMs + 1 : receivedAtMs)
          ),
          backfilled: bar.backfilled === false ? 0 : 1,
          availabilityEstimated: availabilityEstimated ? 1 : 0,
          deduplicated: bar.deduplicated ? 1 : 0,
          gapDetected: bar.gapDetected ? 1 : 0,
          formingCandleExcluded: bar.formingCandleExcluded === false ? 0 : 1,
          availabilityQuality:
            bar.availabilityQuality ||
            (availabilityEstimated ? "estimated" : "exact"),
          revisionStatus: bar.revisionStatus || "not_revisable",
          providerVersion: bar.providerVersion || null,
          licenseId: bar.licenseId || null,
          citationUrl: bar.citationUrl || null,
        });
      }
      return bars.length;
    });
  }

  upsertBars(bars = []) {
    const valid = bars.filter(
      (bar) =>
        bar &&
        typeof bar.symbol === "string" &&
        typeof bar.interval === "string" &&
        Number.isFinite(bar.openTimeMs) &&
        Number.isFinite(bar.closeTimeMs) &&
        ["open", "high", "low", "close", "volume", "quoteVolume"].every(
          (field) => Number.isFinite(bar[field])
        ) &&
        bar.openTimeMs < bar.closeTimeMs
    );
    return this.upsertBarsTransaction(valid);
  }

  latestBar(symbol, interval) {
    return rowToBar(
      this.db
        .prepare(
          `SELECT * FROM market_bars
           WHERE symbol = ? AND interval = ?
           ORDER BY open_time_ms DESC LIMIT 1`
        )
        .get(symbol, interval)
    );
  }

  barAtOrAfter(symbol, interval, openTimeMs) {
    return rowToBar(
      this.db
        .prepare(
          `SELECT * FROM market_bars
           WHERE symbol = ? AND interval = ? AND open_time_ms >= ?
           ORDER BY open_time_ms ASC LIMIT 1`
        )
        .get(symbol, interval, openTimeMs)
    );
  }

  barAtOrBefore(symbol, interval, closeTimeMs) {
    return rowToBar(
      this.db
        .prepare(
          `SELECT * FROM market_bars
           WHERE symbol = ? AND interval = ? AND close_time_ms <= ?
           ORDER BY close_time_ms DESC LIMIT 1`
        )
        .get(symbol, interval, closeTimeMs)
    );
  }

  bars({
    symbol,
    interval,
    beforeMs = Number.MAX_SAFE_INTEGER,
    limit = 10_000,
  }) {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM market_bars
           WHERE symbol = ? AND interval = ? AND open_time_ms <= ?
           ORDER BY open_time_ms DESC LIMIT ?
         ) ORDER BY open_time_ms ASC`
      )
      .all(symbol, interval, beforeMs, Math.max(1, Math.min(limit, 100_000)));
    return rows.map(rowToBar);
  }

  barsAvailableAt({
    symbol,
    interval,
    decisionAtMs,
    beforeMs = Number.MAX_SAFE_INTEGER,
    limit = 10_000,
  }) {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM market_bars
           WHERE symbol = ? AND interval = ? AND open_time_ms <= ?
             AND COALESCE(available_at_ms, close_time_ms + 1) <= ?
           ORDER BY open_time_ms DESC LIMIT ?
         ) ORDER BY open_time_ms ASC`
      )
      .all(
        symbol,
        interval,
        beforeMs,
        decisionAtMs,
        Math.max(1, Math.min(limit, 100_000))
      );
    return rows.map(rowToBar);
  }

  firstGap({ symbol, interval, fromMs = 0, expectedIntervalMs }) {
    const row = this.db
      .prepare(
        `SELECT open_time_ms, previous_open_time_ms
         FROM (
           SELECT open_time_ms,
                  LAG(open_time_ms) OVER (ORDER BY open_time_ms)
                    AS previous_open_time_ms
           FROM market_bars
           WHERE symbol = ? AND interval = ? AND open_time_ms >= ?
         )
         WHERE previous_open_time_ms IS NOT NULL
           AND open_time_ms - previous_open_time_ms != ?
         ORDER BY open_time_ms ASC LIMIT 1`
      )
      .get(symbol, interval, fromMs, expectedIntervalMs);
    if (!row) return null;
    return {
      previousOpenTimeMs: row.previous_open_time_ms,
      nextOpenTimeMs: row.open_time_ms,
      missingFromMs: row.previous_open_time_ms + expectedIntervalMs,
      missingToMs: row.open_time_ms - expectedIntervalMs,
    };
  }

  setSourceHealth({
    source,
    stream,
    status,
    lastEventMs = null,
    lastSuccessMs = null,
    lastErrorCode = null,
    details = null,
  }) {
    this.db
      .prepare(
        `INSERT INTO source_health (
          source, stream, status, last_event_ms, last_success_ms,
          last_error_code, details_json, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, stream) DO UPDATE SET
          status = excluded.status,
          last_event_ms = excluded.last_event_ms,
          last_success_ms = excluded.last_success_ms,
          last_error_code = excluded.last_error_code,
          details_json = excluded.details_json,
          updated_at_ms = excluded.updated_at_ms`
      )
      .run(
        source,
        stream,
        status,
        lastEventMs,
        lastSuccessMs,
        lastErrorCode,
        details ? JSON.stringify(details) : null,
        this.now()
      );
  }

  sourceHealth() {
    return this.db
      .prepare("SELECT * FROM source_health ORDER BY source, stream")
      .all()
      .map((row) => ({
        source: row.source,
        stream: row.stream,
        status: row.status,
        lastEventMs: row.last_event_ms,
        lastSuccessMs: row.last_success_ms,
        lastErrorCode: row.last_error_code,
        details: row.details_json ? JSON.parse(row.details_json) : null,
        updatedAtMs: row.updated_at_ms,
      }));
  }

  acquireLease({ name, ownerId, ttlMs }) {
    const now = this.now();
    const expiresAt = now + ttlMs;
    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO runtime_leases (name, owner_id, expires_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             owner_id = excluded.owner_id,
             expires_at_ms = excluded.expires_at_ms,
             updated_at_ms = excluded.updated_at_ms
           WHERE runtime_leases.expires_at_ms <= ?
              OR runtime_leases.owner_id = excluded.owner_id`
        )
        .run(name, ownerId, expiresAt, now, now);
      const row = this.db
        .prepare("SELECT * FROM runtime_leases WHERE name = ?")
        .get(name);
      return row?.owner_id === ownerId && row?.expires_at_ms === expiresAt;
    })();
  }

  releaseLease({ name, ownerId }) {
    return (
      this.db
        .prepare("DELETE FROM runtime_leases WHERE name = ? AND owner_id = ?")
        .run(name, ownerId).changes > 0
    );
  }

  recordPrediction(prediction) {
    this.db
      .prepare(
        `INSERT INTO predictions (
          prediction_id, symbol, horizon, as_of_ms, outcome_due_ms,
          model_version, feature_schema_version, status, payload_json,
          created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, horizon, as_of_ms, model_version) DO NOTHING`
      )
      .run(
        prediction.predictionId,
        prediction.symbol,
        prediction.horizon,
        prediction.asOfMs,
        prediction.outcomeDueMs,
        prediction.modelVersion,
        prediction.featureSchemaVersion,
        prediction.status,
        JSON.stringify(prediction.payload),
        this.now()
      );
    return this.prediction(prediction.predictionId);
  }

  prediction(predictionId) {
    const row = this.db
      .prepare("SELECT * FROM predictions WHERE prediction_id = ?")
      .get(predictionId);
    return this.deserializePrediction(row);
  }

  latestPrediction(symbol, horizon) {
    return this.deserializePrediction(
      this.db
        .prepare(
          `SELECT * FROM predictions WHERE symbol = ? AND horizon = ?
           ORDER BY as_of_ms DESC, created_at_ms DESC, prediction_id DESC
           LIMIT 1`
        )
        .get(symbol, horizon)
    );
  }

  listPredictions({
    symbol = null,
    horizon = null,
    beforeAsOfMs = Number.MAX_SAFE_INTEGER,
    beforePredictionId = null,
    limit = 50,
  } = {}) {
    const conditions = [];
    const parameters = [];
    if (symbol) {
      conditions.push("symbol = ?");
      parameters.push(symbol);
    }
    if (horizon) {
      conditions.push("horizon = ?");
      parameters.push(horizon);
    }
    conditions.push(
      beforePredictionId
        ? "(as_of_ms < ? OR (as_of_ms = ? AND prediction_id < ?))"
        : "as_of_ms <= ?"
    );
    parameters.push(beforeAsOfMs);
    if (beforePredictionId) parameters.push(beforeAsOfMs, beforePredictionId);
    const bounded = Math.max(1, Math.min(Number(limit) || 50, 101));
    return this.db
      .prepare(
        `SELECT * FROM predictions
         WHERE ${conditions.join(" AND ")}
         ORDER BY as_of_ms DESC, prediction_id DESC LIMIT ?`
      )
      .all(...parameters, bounded)
      .map((row) => this.deserializePrediction(row));
  }

  unresolvedPredictions(nowMs = this.now(), limit = 500) {
    return this.db
      .prepare(
        `SELECT * FROM predictions
         WHERE resolved_at_ms IS NULL AND outcome_due_ms <= ?
         ORDER BY outcome_due_ms ASC LIMIT ?`
      )
      .all(nowMs, limit)
      .map((row) => this.deserializePrediction(row));
  }

  resolvePrediction(predictionId, outcome) {
    this.db
      .prepare(
        `UPDATE predictions SET resolved_at_ms = ?, outcome_json = ?
         WHERE prediction_id = ? AND resolved_at_ms IS NULL`
      )
      .run(this.now(), JSON.stringify(outcome), predictionId);
    return this.prediction(predictionId);
  }

  deserializePrediction(row) {
    if (!row) return null;
    const payload = JSON.parse(row.payload_json);
    return {
      predictionId: row.prediction_id,
      symbol: row.symbol,
      horizon: row.horizon,
      asOfMs: row.as_of_ms,
      outcomeDueMs: row.outcome_due_ms,
      modelVersion: row.model_version,
      featureSchemaVersion: row.feature_schema_version,
      status: row.status,
      payload,
      passportStatus:
        payload?.passport?.schema === "athena.crypto.prediction-passport"
          ? "complete"
          : "legacy_partial",
      createdAtMs: row.created_at_ms,
      resolvedAtMs: row.resolved_at_ms,
      outcome: row.outcome_json ? JSON.parse(row.outcome_json) : null,
    };
  }

  saveFeatureRegistry({ registrySha256, registryVersion, registry }) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO feature_registries (
           registry_sha256, registry_version, registry_json, created_at_ms
         ) VALUES (?, ?, ?, ?)`
      )
      .run(
        registrySha256,
        registryVersion,
        JSON.stringify(registry),
        this.now()
      );
    return registrySha256;
  }

  featureRegistry(registrySha256) {
    const row = this.db
      .prepare("SELECT * FROM feature_registries WHERE registry_sha256 = ?")
      .get(registrySha256);
    if (!row) return null;
    return {
      sha256: row.registry_sha256,
      version: row.registry_version,
      registry: JSON.parse(row.registry_json),
      createdAtMs: row.created_at_ms,
    };
  }

  saveFeatureSnapshot({
    snapshotSha256,
    featureRegistrySha256,
    featureSchemaVersion,
    vector,
    metadata,
  }) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO feature_snapshots (
           snapshot_sha256, feature_registry_sha256, feature_schema_version,
           vector_json, metadata_json, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        snapshotSha256,
        featureRegistrySha256,
        featureSchemaVersion,
        JSON.stringify(vector),
        JSON.stringify(metadata),
        this.now()
      );
    return snapshotSha256;
  }

  featureSnapshot(snapshotSha256) {
    const row = this.db
      .prepare("SELECT * FROM feature_snapshots WHERE snapshot_sha256 = ?")
      .get(snapshotSha256);
    if (!row) return null;
    return {
      sha256: row.snapshot_sha256,
      featureRegistrySha256: row.feature_registry_sha256,
      featureSchemaVersion: row.feature_schema_version,
      vector: JSON.parse(row.vector_json),
      metadata: JSON.parse(row.metadata_json),
      createdAtMs: row.created_at_ms,
    };
  }

  saveCostModel({ costModelSha256, costModelVersion, costModel }) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO cost_models (
           cost_model_sha256, cost_model_version, cost_model_json,
           created_at_ms
         ) VALUES (?, ?, ?, ?)`
      )
      .run(
        costModelSha256,
        costModelVersion,
        JSON.stringify(costModel),
        this.now()
      );
    return costModelSha256;
  }

  costModel(costModelSha256) {
    const row = this.db
      .prepare("SELECT * FROM cost_models WHERE cost_model_sha256 = ?")
      .get(costModelSha256);
    if (!row) return null;
    return {
      sha256: row.cost_model_sha256,
      version: row.cost_model_version,
      costModel: JSON.parse(row.cost_model_json),
      createdAtMs: row.created_at_ms,
    };
  }

  upsertMicrostructureMinute(value) {
    const depths = value.depth || {};
    const parameters = [
      value.symbol,
      value.minuteMs,
      value.source || "binance",
      value.takerBuyQuote || 0,
      value.takerSellQuote || 0,
      value.tradeCount || 0,
      value.cumulativeVolumeDelta || 0,
      value.tradeVelocity || 0,
      value.spreadBpsMean ?? null,
      value.spreadBpsP95 ?? null,
      value.micropriceOffsetBpsMean ?? null,
      ...["10bps", "25bps", "50bps"].flatMap((key) => [
        depths[key]?.bid ?? null,
        depths[key]?.ask ?? null,
        depths[key]?.imbalance ?? null,
      ]),
      value.gapCount || 0,
      value.resyncCount || 0,
      value.samplingCoverage || 0,
      value.availableAtMs,
      this.now(),
    ];
    this.db
      .prepare(
        `INSERT INTO microstructure_minutes (
          symbol, minute_ms, source, taker_buy_quote, taker_sell_quote,
          trade_count, cumulative_volume_delta, trade_velocity,
          spread_bps_mean, spread_bps_p95, microprice_offset_bps_mean,
          bid_depth_10bps, ask_depth_10bps, imbalance_10bps,
          bid_depth_25bps, ask_depth_25bps, imbalance_25bps,
          bid_depth_50bps, ask_depth_50bps, imbalance_50bps,
          gap_count, resync_count, sampling_coverage, available_at_ms,
          created_at_ms
        ) VALUES (${Array(25).fill("?").join(",")})
        ON CONFLICT(symbol, minute_ms) DO UPDATE SET
          source=excluded.source,
          taker_buy_quote=excluded.taker_buy_quote,
          taker_sell_quote=excluded.taker_sell_quote,
          trade_count=excluded.trade_count,
          cumulative_volume_delta=excluded.cumulative_volume_delta,
          trade_velocity=excluded.trade_velocity,
          spread_bps_mean=excluded.spread_bps_mean,
          spread_bps_p95=excluded.spread_bps_p95,
          microprice_offset_bps_mean=excluded.microprice_offset_bps_mean,
          bid_depth_10bps=excluded.bid_depth_10bps,
          ask_depth_10bps=excluded.ask_depth_10bps,
          imbalance_10bps=excluded.imbalance_10bps,
          bid_depth_25bps=excluded.bid_depth_25bps,
          ask_depth_25bps=excluded.ask_depth_25bps,
          imbalance_25bps=excluded.imbalance_25bps,
          bid_depth_50bps=excluded.bid_depth_50bps,
          ask_depth_50bps=excluded.ask_depth_50bps,
          imbalance_50bps=excluded.imbalance_50bps,
          gap_count=excluded.gap_count,
          resync_count=excluded.resync_count,
          sampling_coverage=excluded.sampling_coverage,
          available_at_ms=excluded.available_at_ms,
          created_at_ms=excluded.created_at_ms`
      )
      .run(...parameters);
    return value;
  }

  microstructureMinutes({ symbol, sinceMs = 0, limit = 1_000 }) {
    return this.db
      .prepare(
        `SELECT * FROM microstructure_minutes
         WHERE symbol = ? AND minute_ms >= ?
         ORDER BY minute_ms DESC LIMIT ?`
      )
      .all(
        symbol,
        sinceMs,
        Math.max(1, Math.min(Number(limit) || 1_000, 10_000))
      )
      .map((row) => ({
        symbol: row.symbol,
        minuteMs: row.minute_ms,
        source: row.source,
        takerBuyQuote: row.taker_buy_quote,
        takerSellQuote: row.taker_sell_quote,
        tradeCount: row.trade_count,
        cumulativeVolumeDelta: row.cumulative_volume_delta,
        tradeVelocity: row.trade_velocity,
        spreadBpsMean: row.spread_bps_mean,
        spreadBpsP95: row.spread_bps_p95,
        micropriceOffsetBpsMean: row.microprice_offset_bps_mean,
        depth: Object.fromEntries(
          ["10bps", "25bps", "50bps"].map((key) => {
            const prefix = key.replace("bps", "");
            return [
              key,
              {
                bid: row[`bid_depth_${prefix}bps`],
                ask: row[`ask_depth_${prefix}bps`],
                imbalance: row[`imbalance_${prefix}bps`],
              },
            ];
          })
        ),
        gapCount: row.gap_count,
        resyncCount: row.resync_count,
        samplingCoverage: row.sampling_coverage,
        availableAtMs: row.available_at_ms,
      }));
  }

  microstructureCoverage() {
    return this.db
      .prepare(
        `SELECT symbol, COUNT(*) AS rows,
                MIN(minute_ms) AS first_minute_ms,
                MAX(minute_ms) AS last_minute_ms,
                AVG(sampling_coverage) AS average_sampling_coverage,
                SUM(gap_count) AS gaps,
                SUM(resync_count) AS resyncs
         FROM microstructure_minutes
         GROUP BY symbol ORDER BY symbol`
      )
      .all()
      .map((row) => {
        const observedDays =
          row.first_minute_ms === null || row.last_minute_ms === null
            ? 0
            : (row.last_minute_ms - row.first_minute_ms) / 86_400_000;
        const expectedMinutes = Math.max(
          1,
          Math.floor(observedDays * 1_440) + 1
        );
        const minuteCoverage = Math.min(1, row.rows / expectedMinutes);
        return {
          symbol: row.symbol,
          rows: row.rows,
          firstMinuteMs: row.first_minute_ms,
          lastMinuteMs: row.last_minute_ms,
          observedDays,
          minuteCoverage,
          averageSamplingCoverage: row.average_sampling_coverage,
          gaps: row.gaps,
          resyncs: row.resyncs,
          modelInputEligible:
            observedDays >= 180 &&
            minuteCoverage >= 0.95 &&
            Number(row.average_sampling_coverage || 0) >= 0.95 &&
            Number(row.gaps || 0) / expectedMinutes < 0.005,
          role: "supporting_only",
        };
      });
  }

  upsertDerivativeKlines(rows = []) {
    const statement = this.db.prepare(`
      INSERT INTO derivative_klines (
        symbol, series_type, interval, open_time_ms, close_time_ms,
        open, high, low, close, source, available_at_ms, created_at_ms
      ) VALUES (
        @symbol, @seriesType, @interval, @openTimeMs, @closeTimeMs,
        @open, @high, @low, @close, @source, @availableAtMs, @createdAtMs
      )
      ON CONFLICT(symbol, series_type, interval, open_time_ms) DO UPDATE SET
        close_time_ms=excluded.close_time_ms,
        open=excluded.open,
        high=excluded.high,
        low=excluded.low,
        close=excluded.close,
        source=excluded.source,
        available_at_ms=MIN(
          derivative_klines.available_at_ms,
          excluded.available_at_ms
        )
    `);
    return this.db.transaction((values) => {
      for (const row of values)
        statement.run({ ...row, createdAtMs: this.now() });
      return values.length;
    })(rows);
  }

  upsertFundingRates(rows = []) {
    const statement = this.db.prepare(`
      INSERT INTO derivative_funding_rates (
        symbol, calc_time_ms, funding_interval_hours, funding_rate,
        source, available_at_ms, created_at_ms
      ) VALUES (
        @symbol, @calcTimeMs, @fundingIntervalHours, @fundingRate,
        @source, @availableAtMs, @createdAtMs
      )
      ON CONFLICT(symbol, calc_time_ms) DO UPDATE SET
        funding_interval_hours=excluded.funding_interval_hours,
        funding_rate=excluded.funding_rate,
        source=excluded.source,
        available_at_ms=MIN(
          derivative_funding_rates.available_at_ms,
          excluded.available_at_ms
        )
    `);
    return this.db.transaction((values) => {
      for (const row of values)
        statement.run({ ...row, createdAtMs: this.now() });
      return values.length;
    })(rows);
  }

  upsertDerivativeMetrics(rows = []) {
    const statement = this.db.prepare(`
      INSERT INTO derivative_metrics (
        symbol, create_time_ms, sum_open_interest, sum_open_interest_value,
        count_toptrader_long_short_ratio, sum_toptrader_long_short_ratio,
        count_long_short_ratio, sum_taker_long_short_vol_ratio,
        source, available_at_ms, created_at_ms
      ) VALUES (
        @symbol, @createTimeMs, @sumOpenInterest, @sumOpenInterestValue,
        @countToptraderLongShortRatio, @sumToptraderLongShortRatio,
        @countLongShortRatio, @sumTakerLongShortVolRatio,
        @source, @availableAtMs, @createdAtMs
      )
      ON CONFLICT(symbol, create_time_ms) DO UPDATE SET
        sum_open_interest=excluded.sum_open_interest,
        sum_open_interest_value=excluded.sum_open_interest_value,
        count_toptrader_long_short_ratio=
          excluded.count_toptrader_long_short_ratio,
        sum_toptrader_long_short_ratio=
          excluded.sum_toptrader_long_short_ratio,
        count_long_short_ratio=excluded.count_long_short_ratio,
        sum_taker_long_short_vol_ratio=
          excluded.sum_taker_long_short_vol_ratio,
        source=excluded.source,
        available_at_ms=MIN(
          derivative_metrics.available_at_ms,
          excluded.available_at_ms
        )
    `);
    return this.db.transaction((values) => {
      for (const row of values)
        statement.run({ ...row, createdAtMs: this.now() });
      return values.length;
    })(rows);
  }

  derivativeCoverage() {
    const intervalMs = {
      "5m": 5 * 60_000,
      "1h": 60 * 60_000,
    };
    const series = this.db
      .prepare(
        `SELECT symbol, series_type, interval, COUNT(*) AS rows,
                MIN(open_time_ms) AS first_ms, MAX(open_time_ms) AS last_ms
         FROM derivative_klines
         GROUP BY symbol, series_type, interval
         ORDER BY symbol, series_type, interval`
      )
      .all()
      .map((row) => {
        const step = intervalMs[row.interval] || 0;
        const expected =
          step > 0 && row.first_ms !== null && row.last_ms !== null
            ? Math.floor((row.last_ms - row.first_ms) / step) + 1
            : row.rows;
        const observedDays =
          row.first_ms === null || row.last_ms === null
            ? 0
            : (row.last_ms - row.first_ms) / 86_400_000;
        const coverage = expected > 0 ? Math.min(1, row.rows / expected) : 0;
        const gapRate =
          expected > 0 ? Math.max(0, expected - row.rows) / expected : 1;
        return {
          symbol: row.symbol,
          source: row.series_type,
          interval: row.interval,
          rows: row.rows,
          firstMs: row.first_ms,
          lastMs: row.last_ms,
          observedDays,
          coverage,
          gapRate,
          modelInputEligible:
            observedDays >= 180 && coverage >= 0.95 && gapRate < 0.005,
        };
      });
    const funding = this.db
      .prepare(
        `SELECT symbol, COUNT(*) AS rows, MIN(calc_time_ms) AS first_ms,
                MAX(calc_time_ms) AS last_ms
         FROM derivative_funding_rates GROUP BY symbol ORDER BY symbol`
      )
      .all()
      .map((row) => {
        const observedDays =
          row.first_ms === null || row.last_ms === null
            ? 0
            : (row.last_ms - row.first_ms) / 86_400_000;
        return {
          symbol: row.symbol,
          source: "funding_rate",
          rows: row.rows,
          firstMs: row.first_ms,
          lastMs: row.last_ms,
          observedDays,
          modelInputEligible: observedDays >= 180 && row.rows >= 180 * 3,
        };
      });
    const metrics = this.db
      .prepare(
        `SELECT symbol, COUNT(*) AS rows, MIN(create_time_ms) AS first_ms,
                MAX(create_time_ms) AS last_ms
         FROM derivative_metrics GROUP BY symbol ORDER BY symbol`
      )
      .all()
      .map((row) => {
        const observedDays =
          row.first_ms === null || row.last_ms === null
            ? 0
            : (row.last_ms - row.first_ms) / 86_400_000;
        const expected = Math.max(
          1,
          Math.floor((row.last_ms - row.first_ms) / (5 * 60_000)) + 1
        );
        const coverage = Math.min(1, row.rows / expected);
        const gapRate = Math.max(0, expected - row.rows) / expected;
        return {
          symbol: row.symbol,
          source: "metrics",
          rows: row.rows,
          firstMs: row.first_ms,
          lastMs: row.last_ms,
          observedDays,
          coverage,
          gapRate,
          modelInputEligible:
            observedDays >= 180 && coverage >= 0.95 && gapRate < 0.005,
        };
      });
    return [...series, ...funding, ...metrics];
  }

  derivativeKlineAtOrAfter({
    symbol,
    seriesType,
    interval = "5m",
    openTimeMs,
  }) {
    const row = this.db
      .prepare(
        `SELECT * FROM derivative_klines
         WHERE symbol=? AND series_type=? AND interval=? AND open_time_ms>=?
         ORDER BY open_time_ms ASC LIMIT 1`
      )
      .get(symbol, seriesType, interval, openTimeMs);
    if (!row) return null;
    return {
      symbol: row.symbol,
      seriesType: row.series_type,
      interval: row.interval,
      openTimeMs: row.open_time_ms,
      closeTimeMs: row.close_time_ms,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      source: row.source,
      availableAtMs: row.available_at_ms,
    };
  }

  derivativeKlineAtOrBefore({
    symbol,
    seriesType,
    interval = "5m",
    closeTimeMs,
  }) {
    const row = this.db
      .prepare(
        `SELECT * FROM derivative_klines
         WHERE symbol=? AND series_type=? AND interval=? AND close_time_ms<=?
         ORDER BY close_time_ms DESC LIMIT 1`
      )
      .get(symbol, seriesType, interval, closeTimeMs);
    if (!row) return null;
    return {
      symbol: row.symbol,
      seriesType: row.series_type,
      interval: row.interval,
      openTimeMs: row.open_time_ms,
      closeTimeMs: row.close_time_ms,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      source: row.source,
      availableAtMs: row.available_at_ms,
    };
  }

  fundingRates({
    symbol,
    fromMs = 0,
    toMs = Number.MAX_SAFE_INTEGER,
    availableByMs = Number.MAX_SAFE_INTEGER,
  }) {
    return this.db
      .prepare(
        `SELECT * FROM derivative_funding_rates
         WHERE symbol=? AND calc_time_ms>? AND calc_time_ms<=?
           AND available_at_ms<=?
         ORDER BY calc_time_ms ASC`
      )
      .all(symbol, fromMs, toMs, availableByMs)
      .map((row) => ({
        symbol: row.symbol,
        calcTimeMs: row.calc_time_ms,
        fundingIntervalHours: row.funding_interval_hours,
        fundingRate: row.funding_rate,
        source: row.source,
        availableAtMs: row.available_at_ms,
      }));
  }

  predictionPassport(predictionId) {
    const prediction = this.prediction(predictionId);
    if (!prediction) return null;
    if (prediction.passportStatus !== "complete")
      return { ...prediction, passport: null };
    const passport = prediction.payload.passport;
    return {
      ...prediction,
      passport: {
        ...passport,
        featureSnapshot: this.featureSnapshot(passport.featureSnapshotSha256),
        featureRegistry: this.featureRegistry(passport.featureRegistrySha256),
        costModel: this.costModel(passport.costModelSha256),
        outcome: prediction.outcome,
      },
    };
  }

  saveDatasetManifest(manifest) {
    const serialized = JSON.stringify(manifest);
    const sha256 = crypto.createHash("sha256").update(serialized).digest("hex");
    this.db
      .prepare(
        `INSERT OR IGNORE INTO dataset_manifests
         (manifest_sha256, manifest_json, created_at_ms) VALUES (?, ?, ?)`
      )
      .run(sha256, serialized, this.now());
    return sha256;
  }

  recordCandidateObservation({
    source,
    symbol,
    observedAtMs,
    availableAtMs = this.now(),
    receivedAtMs = this.now(),
    availabilityEstimated = true,
    availabilityQuality = availabilityEstimated ? "estimated" : "exact",
    revisionStatus = "unknown",
    providerVersion = null,
    licenseId = null,
    citationUrl = null,
    eventId = null,
    status = "candidate",
    payload,
  }) {
    if (
      !source ||
      !symbol ||
      !Number.isFinite(observedAtMs) ||
      !Number.isFinite(availableAtMs) ||
      !Number.isFinite(receivedAtMs) ||
      !payload
    )
      return false;
    return (
      this.db
        .prepare(
          `INSERT INTO candidate_observations (
             source, symbol, observed_at_ms, available_at_ms, status,
             payload_json, created_at_ms, received_at_ms,
             availability_estimated, availability_quality, revision_status,
             provider_version, license_id, citation_url, event_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source, symbol, observed_at_ms) DO UPDATE SET
             available_at_ms = MIN(
               candidate_observations.available_at_ms,
               excluded.available_at_ms
             ),
             status = excluded.status,
             payload_json = excluded.payload_json,
             received_at_ms = MIN(
               COALESCE(candidate_observations.received_at_ms,
                        excluded.received_at_ms),
               excluded.received_at_ms
             ),
             availability_estimated = excluded.availability_estimated,
             availability_quality = excluded.availability_quality,
             revision_status = excluded.revision_status,
             provider_version = excluded.provider_version,
             license_id = excluded.license_id,
             citation_url = excluded.citation_url,
             event_id = COALESCE(excluded.event_id,
                                 candidate_observations.event_id)`
        )
        .run(
          source,
          symbol,
          observedAtMs,
          availableAtMs,
          status,
          JSON.stringify(payload),
          this.now(),
          receivedAtMs,
          availabilityEstimated ? 1 : 0,
          availabilityQuality,
          revisionStatus,
          providerVersion,
          licenseId,
          citationUrl,
          eventId
        ).changes > 0
    );
  }

  candidateObservations({
    source,
    symbol,
    fromMs = 0,
    toMs = Number.MAX_SAFE_INTEGER,
    availableByMs = Number.MAX_SAFE_INTEGER,
    limit = 10_000,
  }) {
    return this.db
      .prepare(
        `SELECT * FROM candidate_observations
         WHERE source = ? AND symbol = ?
           AND observed_at_ms >= ? AND observed_at_ms <= ?
           AND available_at_ms <= ?
         ORDER BY observed_at_ms ASC LIMIT ?`
      )
      .all(
        source,
        symbol,
        fromMs,
        toMs,
        availableByMs,
        Math.max(1, Math.min(limit, 100_000))
      )
      .map((row) => ({
        source: row.source,
        symbol: row.symbol,
        observedAtMs: row.observed_at_ms,
        availableAtMs: row.available_at_ms,
        receivedAtMs: row.received_at_ms || row.created_at_ms,
        availabilityEstimated: Boolean(row.availability_estimated),
        availabilityQuality:
          row.availability_quality ||
          (row.availability_estimated ? "estimated" : "exact"),
        revisionStatus: row.revision_status || "unknown",
        providerVersion: row.provider_version || null,
        licenseId: row.license_id || null,
        citationUrl: row.citation_url || null,
        eventId: row.event_id || null,
        status: row.status,
        payload: JSON.parse(row.payload_json),
      }));
  }

  candidateCoverage() {
    return this.db
      .prepare(
        `SELECT source, symbol, COUNT(*) AS rows,
                MIN(observed_at_ms) AS first_observed_at_ms,
                MAX(observed_at_ms) AS last_observed_at_ms,
                MAX(available_at_ms) AS last_available_at_ms,
                SUM(CASE WHEN availability_quality='exact' THEN 1 ELSE 0 END)
                  AS exact_rows,
                SUM(CASE WHEN availability_quality='organic_only' THEN 1
                         ELSE 0 END) AS organic_rows
         FROM candidate_observations
         GROUP BY source, symbol
         ORDER BY source, symbol`
      )
      .all()
      .map((row) => ({
        source: row.source,
        symbol: row.symbol,
        rows: row.rows,
        firstObservedAtMs: row.first_observed_at_ms,
        lastObservedAtMs: row.last_observed_at_ms,
        lastAvailableAtMs: row.last_available_at_ms,
        exactRows: Number(row.exact_rows || 0),
        organicRows: Number(row.organic_rows || 0),
      }));
  }

  datasetSummary() {
    const bars = this.db
      .prepare(
        `SELECT symbol, interval, COUNT(*) AS rows,
                MIN(open_time_ms) AS first_open_time_ms,
                MAX(close_time_ms) AS last_close_time_ms
         FROM market_bars
         GROUP BY symbol, interval
         ORDER BY symbol, interval`
      )
      .all()
      .map((row) => ({
        symbol: row.symbol,
        interval: row.interval,
        rows: row.rows,
        firstOpenTimeMs: row.first_open_time_ms,
        lastCloseTimeMs: row.last_close_time_ms,
      }));
    const predictions = this.db
      .prepare(
        `SELECT status, COUNT(*) AS rows
         FROM predictions GROUP BY status ORDER BY status`
      )
      .all()
      .map((row) => ({ status: row.status, rows: row.rows }));
    return {
      bars,
      predictions,
      candidateObservations: this.candidateCoverage(),
      microstructure: this.microstructureCoverage(),
      featureSnapshots: this.db
        .prepare("SELECT COUNT(*) AS rows FROM feature_snapshots")
        .get().rows,
      featureRegistries: this.db
        .prepare("SELECT COUNT(*) AS rows FROM feature_registries")
        .get().rows,
      costModels: this.db
        .prepare("SELECT COUNT(*) AS rows FROM cost_models")
        .get().rows,
    };
  }

  async exportReadOnlySnapshot(destination) {
    const resolved = path.resolve(destination);
    if (resolved === this.databasePath)
      throw new Error("snapshot_destination_matches_source");
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    await this.db.backup(resolved);
    fs.chmodSync(resolved, 0o400);
    const buffer = fs.readFileSync(resolved);
    return {
      path: resolved,
      bytes: buffer.length,
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      summary: this.datasetSummary(),
    };
  }

  prune({ nowMs = this.now() } = {}) {
    const cutoff = nowMs - ONE_MINUTE_RETENTION_MS;
    const deleted = this.db
      .prepare(
        "DELETE FROM market_bars WHERE interval = '1m' AND open_time_ms < ?"
      )
      .run(cutoff).changes;
    this.db.pragma("wal_checkpoint(PASSIVE)");
    return { deleted, cutoff };
  }

  capacity({
    maxStoreBytes = MAX_STORE_BYTES,
    minFreeBytes = MIN_FREE_BYTES,
  } = {}) {
    const storageBytes = directorySize(this.root);
    const freeBytes = diskFreeBytes(this.root);
    const allowed = storageBytes < maxStoreBytes && freeBytes >= minFreeBytes;
    return {
      allowed,
      storageBytes,
      freeBytes,
      maxStoreBytes,
      minFreeBytes,
      reason:
        storageBytes >= maxStoreBytes
          ? "store_limit_reached"
          : freeBytes < minFreeBytes
            ? "disk_reserve_reached"
            : null,
    };
  }

  close() {
    if (!this.db?.open) return;
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.close();
  }
}

module.exports = {
  assertEmbeddedSqliteStoreAllowed,
  CryptoForecastStore,
  directorySize,
  diskFreeBytes,
  rowToBar,
};
