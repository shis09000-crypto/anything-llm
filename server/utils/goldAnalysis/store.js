const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const {
  MAX_STORE_BYTES,
  MIN_FREE_BYTES,
  goldAnalysisRoot,
} = require("./constants");

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

function freeBytes(root) {
  const stat = fs.statfsSync(root);
  return Number(stat.bavail) * Number(stat.bsize);
}

class GoldAnalysisStore {
  constructor({ root = goldAnalysisRoot(), now = () => Date.now() } = {}) {
    this.root = path.resolve(root);
    this.now = now;
    fs.mkdirSync(this.root, { recursive: true });
    this.databasePath = path.join(this.root, "gold-analysis.db");
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
      CREATE TABLE IF NOT EXISTS normalized_observations (
        source TEXT NOT NULL,
        event_id TEXT PRIMARY KEY,
        observed_at_ms INTEGER NOT NULL,
        available_at_ms INTEGER NOT NULL,
        envelope_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS gold_observations_lookup
        ON normalized_observations(source, observed_at_ms DESC);

      CREATE TABLE IF NOT EXISTS analysis_snapshots (
        result_sha256 TEXT PRIMARY KEY,
        as_of_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS gold_snapshots_latest
        ON analysis_snapshots(as_of_ms DESC);

      CREATE TABLE IF NOT EXISTS shadow_research (
        research_id TEXT PRIMARY KEY,
        as_of_ms INTEGER NOT NULL,
        dataset_sha256 TEXT NOT NULL,
        registry_sha256 TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS gold_shadow_latest
        ON shadow_research(as_of_ms DESC);

      CREATE TABLE IF NOT EXISTS source_health (
        source TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        last_success_ms INTEGER,
        last_error_code TEXT,
        details_json TEXT,
        updated_at_ms INTEGER NOT NULL
      );
    `);
  }

  prepare() {
    this.insertObservation = this.db.prepare(`
      INSERT INTO normalized_observations (
        source, event_id, observed_at_ms, available_at_ms,
        envelope_json, payload_json, created_at_ms
      ) VALUES (
        @source, @eventId, @observedAtMs, @availableAtMs,
        @envelopeJson, @payloadJson, @createdAtMs
      )
      ON CONFLICT(event_id) DO UPDATE SET
        available_at_ms=excluded.available_at_ms,
        envelope_json=excluded.envelope_json,
        payload_json=excluded.payload_json
    `);
    this.insertSnapshot = this.db.prepare(`
      INSERT OR REPLACE INTO analysis_snapshots (
        result_sha256, as_of_ms, status, payload_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?)
    `);
    this.insertResearch = this.db.prepare(`
      INSERT OR REPLACE INTO shadow_research (
        research_id, as_of_ms, dataset_sha256, registry_sha256,
        status, payload_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.upsertSourceHealth = this.db.prepare(`
      INSERT INTO source_health (
        source, status, last_success_ms, last_error_code,
        details_json, updated_at_ms
      ) VALUES (
        @source, @status, @lastSuccessMs, @lastErrorCode,
        @detailsJson, @updatedAtMs
      )
      ON CONFLICT(source) DO UPDATE SET
        status=excluded.status,
        last_success_ms=COALESCE(excluded.last_success_ms, source_health.last_success_ms),
        last_error_code=excluded.last_error_code,
        details_json=excluded.details_json,
        updated_at_ms=excluded.updated_at_ms
    `);
  }

  writable() {
    return (
      directorySize(this.root) < MAX_STORE_BYTES &&
      freeBytes(this.root) >= MIN_FREE_BYTES
    );
  }

  saveObservations(rows = []) {
    if (!rows.length || !this.writable()) return false;
    const createdAtMs = this.now();
    const transaction = this.db.transaction((items) => {
      for (const row of items)
        this.insertObservation.run({
          source: row.envelope.source,
          eventId: row.envelope.eventId,
          observedAtMs: row.envelope.observedAtMs,
          availableAtMs: row.envelope.availableAtMs,
          envelopeJson: JSON.stringify(row.envelope),
          payloadJson: JSON.stringify(row.payload),
          createdAtMs,
        });
    });
    transaction(rows);
    return true;
  }

  saveSnapshot({ resultSha256, asOfMs, status, payload }) {
    if (!this.writable()) return false;
    this.insertSnapshot.run(
      resultSha256,
      asOfMs,
      status,
      JSON.stringify(payload),
      this.now()
    );
    this.trim();
    return true;
  }

  latestSnapshot(maxAgeMs = Infinity) {
    const row = this.db
      .prepare(
        `SELECT * FROM analysis_snapshots ORDER BY as_of_ms DESC LIMIT 1`
      )
      .get();
    if (!row || this.now() - row.as_of_ms > maxAgeMs) return null;
    return {
      resultSha256: row.result_sha256,
      asOfMs: row.as_of_ms,
      status: row.status,
      payload: JSON.parse(row.payload_json),
    };
  }

  recentBars({ symbol, interval, limit = 20_000 }) {
    const bounded = Math.max(1, Math.min(Number(limit) || 20_000, 100_000));
    const rows = this.db
      .prepare(
        `SELECT payload_json
         FROM normalized_observations
         WHERE source = 'twelve_data'
           AND json_extract(payload_json, '$.symbol') = ?
           AND json_extract(payload_json, '$.interval') = ?
         ORDER BY observed_at_ms DESC
         LIMIT ?`
      )
      .all(symbol, interval, bounded);
    const byOpen = new Map();
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json);
      if (payload.symbol !== symbol || payload.interval !== interval) continue;
      if (!Number.isFinite(Number(payload.openTimeMs))) continue;
      byOpen.set(Number(payload.openTimeMs), {
        source: "twelve_data",
        providerVersion:
          payload.providerVersion || "twelve-data-time-series-v1",
        symbol,
        interval,
        openTimeMs: Number(payload.openTimeMs),
        closeTimeMs: Number(payload.closeTimeMs),
        open: Number(payload.open),
        high: Number(payload.high),
        low: Number(payload.low),
        close: Number(payload.close),
        volume:
          payload.volume === null || payload.volume === undefined
            ? null
            : Number(payload.volume),
        backfilled: true,
        forming: false,
      });
      if (byOpen.size >= bounded) break;
    }
    return [...byOpen.values()].sort(
      (left, right) => left.openTimeMs - right.openTimeMs
    );
  }

  saveShadowResearch({
    researchId,
    asOfMs,
    datasetSha256,
    registrySha256,
    status,
    payload,
  }) {
    if (!this.writable()) return false;
    this.insertResearch.run(
      researchId,
      asOfMs,
      datasetSha256,
      registrySha256,
      status,
      JSON.stringify(payload),
      this.now()
    );
    return true;
  }

  setSourceHealth(source, status, errorCode = null, details = {}) {
    this.upsertSourceHealth.run({
      source,
      status,
      lastSuccessMs: status === "available" ? this.now() : null,
      lastErrorCode: errorCode,
      detailsJson: JSON.stringify(details || {}),
      updatedAtMs: this.now(),
    });
  }

  health() {
    return this.db
      .prepare(`SELECT * FROM source_health ORDER BY source`)
      .all()
      .map((row) => ({
        source: row.source,
        status: row.status,
        lastSuccessMs: row.last_success_ms,
        lastErrorCode: row.last_error_code,
        details: JSON.parse(row.details_json || "{}"),
        updatedAtMs: row.updated_at_ms,
      }));
  }

  trim() {
    this.db
      .prepare(
        `DELETE FROM analysis_snapshots
         WHERE result_sha256 NOT IN (
           SELECT result_sha256 FROM analysis_snapshots
           ORDER BY as_of_ms DESC LIMIT 200
         )`
      )
      .run();
    this.db
      .prepare(
        `DELETE FROM normalized_observations
         WHERE created_at_ms < ?`
      )
      .run(this.now() - 365 * 24 * 60 * 60 * 1_000);
  }

  stats() {
    return {
      root: this.root,
      bytes: directorySize(this.root),
      freeBytes: freeBytes(this.root),
      writable: this.writable(),
      snapshots: this.db
        .prepare(`SELECT COUNT(*) AS count FROM analysis_snapshots`)
        .get().count,
      observations: this.db
        .prepare(`SELECT COUNT(*) AS count FROM normalized_observations`)
        .get().count,
      shadowResearch: this.db
        .prepare(`SELECT COUNT(*) AS count FROM shadow_research`)
        .get().count,
    };
  }

  close() {
    this.db.close();
  }
}

module.exports = { GoldAnalysisStore, directorySize, freeBytes };
