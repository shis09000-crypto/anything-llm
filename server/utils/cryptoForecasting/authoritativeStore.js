const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Pool } = require("pg");
const {
  contentObjectProvider,
} = require("../../providers/storage/contentObjectProvider");
const { mainPostgresqlUrl } = require("../database/databaseProvider");
const { CryptoForecastStore } = require("./store");

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function remoteStoreEnabled(env = process.env) {
  return (
    String(env.ATHENA_CRYPTO_FORECAST_STORE || "").trim().toLowerCase() ===
    "postgres-s3"
  );
}

async function latestSnapshot(pool) {
  const result = await pool.query(`
    SELECT snapshot_sha256, object_key, bytes, summary_json, created_at
      FROM public.crypto_forecast_store_snapshots
     ORDER BY created_at DESC, id DESC
     LIMIT 1
  `);
  return result.rows[0] || null;
}

class AuthoritativeCryptoForecastStore extends CryptoForecastStore {
  constructor({ root, env, now, pool, provider, instanceId, restoredSnapshot }) {
    super({ root, env, now, persistenceMode: "remote-cache" });
    this.env = env;
    this.pool = pool;
    this.provider = provider;
    this.instanceId = instanceId;
    this.restoredSnapshot = restoredSnapshot;
    this.lastCheckpoint = restoredSnapshot;
    this.lastCheckpointAt = restoredSnapshot?.createdAt
      ? new Date(restoredSnapshot.createdAt).getTime()
      : 0;
  }

  async checkpoint({ force = false } = {}) {
    const intervalMs = Math.max(
      60_000,
      Number(this.env.ATHENA_CRYPTO_FORECAST_CHECKPOINT_MS || 300_000)
    );
    if (!force && Date.now() - this.lastCheckpointAt < intervalMs)
      return { skipped: true, reason: "checkpoint_interval", ...this.lastCheckpoint };
    const target = path.join(
      this.root,
      "tmp",
      `forecast-${Date.now()}-${crypto.randomUUID()}.sqlite`
    );
    const snapshot = await this.exportReadOnlySnapshot(target);
    const objectKey = `crypto/forecast/store-snapshots/${snapshot.sha256}.sqlite`;
    try {
      await this.provider.putImmutableFile({
        objectKey,
        sourcePath: snapshot.path,
        ciphertextSha256: snapshot.sha256,
      });
      await this.pool.query(
        `INSERT INTO public.crypto_forecast_store_snapshots (
           snapshot_sha256, object_key, bytes, summary_json,
           producer_instance, created_at
         ) VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
         ON CONFLICT (snapshot_sha256) DO NOTHING`,
        [
          snapshot.sha256,
          objectKey,
          snapshot.bytes,
          JSON.stringify(snapshot.summary),
          this.instanceId,
        ]
      );
      this.lastCheckpoint = {
        snapshotSha256: snapshot.sha256,
        objectKey,
        bytes: snapshot.bytes,
      };
      this.lastCheckpointAt = Date.now();
      return this.lastCheckpoint;
    } finally {
      fs.rmSync(target, { force: true });
    }
  }

  authoritativeStatus() {
    return {
      mode: "postgres-s3",
      restoredSnapshot: this.restoredSnapshot,
      lastCheckpoint: this.lastCheckpoint,
      checkpointIntervalMs: Math.max(
        60_000,
        Number(this.env.ATHENA_CRYPTO_FORECAST_CHECKPOINT_MS || 300_000)
      ),
      cacheDurable: false,
    };
  }

  async closeAuthoritative() {
    super.close();
    await this.pool.end();
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

async function createAuthoritativeCryptoForecastStore({
  env = process.env,
  now = () => Date.now(),
  pool = null,
  provider = null,
} = {}) {
  if (!remoteStoreEnabled(env))
    throw new Error("crypto_forecast_postgres_s3_store_required");
  const instanceId = `${process.pid}:${crypto.randomUUID()}`;
  const cacheParent = path.resolve(
    env.ATHENA_CRYPTO_FORECAST_CACHE_ROOT ||
      path.join(os.tmpdir(), "athena-crypto-forecast-cache")
  );
  if (!cacheParent.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`))
    throw new Error("crypto_forecast_cache_must_be_transient");
  fs.mkdirSync(cacheParent, { recursive: true, mode: 0o700 });
  const root = fs.mkdtempSync(path.join(cacheParent, "instance-"));
  const databasePath = path.join(root, "online-features.db");
  const databasePool =
    pool || new Pool({ connectionString: mainPostgresqlUrl(env) });
  const objectProvider = provider || contentObjectProvider(env);
  let restoredSnapshot = null;
  try {
    const latest = await latestSnapshot(databasePool);
    if (latest) {
      await objectProvider.writeToFile({
        objectKey: latest.object_key,
        destinationPath: databasePath,
      });
      const actualSha256 = sha256File(databasePath);
      if (actualSha256 !== latest.snapshot_sha256) {
        const error = new Error("crypto_forecast_snapshot_integrity_failed");
        error.code = "CRYPTO_FORECAST_SNAPSHOT_INTEGRITY_FAILED";
        throw error;
      }
      restoredSnapshot = {
        snapshotSha256: latest.snapshot_sha256,
        objectKey: latest.object_key,
        bytes: Number(latest.bytes),
        createdAt: latest.created_at,
      };
    }
    return new AuthoritativeCryptoForecastStore({
      root,
      env,
      now,
      pool: databasePool,
      provider: objectProvider,
      instanceId,
      restoredSnapshot,
    });
  } catch (error) {
    await databasePool.end().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

module.exports = {
  AuthoritativeCryptoForecastStore,
  createAuthoritativeCryptoForecastStore,
  latestSnapshot,
  remoteStoreEnabled,
  sha256File,
};
