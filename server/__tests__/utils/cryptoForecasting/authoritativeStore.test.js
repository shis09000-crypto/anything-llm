/* eslint-env jest */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  AuthoritativeCryptoForecastStore,
  remoteStoreEnabled,
} = require("../../../utils/cryptoForecasting/authoritativeStore");
const {
  CryptoForecastStore,
} = require("../../../utils/cryptoForecasting/store");

describe("authoritative crypto forecast store", () => {
  test("distributed topology refuses a durable embedded SQLite store", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "forecast-embedded-"));
    expect(
      () =>
        new CryptoForecastStore({
          root,
          env: {
            ATHENA_DATABASE_PROVIDER: "postgresql",
            ATHENA_RUNTIME_TOPOLOGY: "distributed",
          },
        })
    ).toThrow("crypto_forecast_embedded_sqlite_forbidden");
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("remote cache checkpoints to immutable S3 and PostgreSQL metadata", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "forecast-remote-"));
    const provider = { putImmutableFile: jest.fn().mockResolvedValue({ created: true }) };
    const pool = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      end: jest.fn().mockResolvedValue(undefined),
    };
    const store = new AuthoritativeCryptoForecastStore({
      root,
      env: {
        ATHENA_DATABASE_PROVIDER: "postgresql",
        ATHENA_RUNTIME_TOPOLOGY: "distributed",
        ATHENA_CRYPTO_FORECAST_STORE: "postgres-s3",
      },
      pool,
      provider,
      instanceId: "test-instance",
      restoredSnapshot: null,
    });
    store.saveDatasetManifest({
      manifestSha256: "a".repeat(64),
      manifest: { schema: "test" },
    });

    const checkpoint = await store.checkpoint();
    expect(checkpoint.snapshotSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(provider.putImmutableFile).toHaveBeenCalledWith(
      expect.objectContaining({
        objectKey: expect.stringContaining(checkpoint.snapshotSha256),
        ciphertextSha256: checkpoint.snapshotSha256,
      })
    );
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("crypto_forecast_store_snapshots"),
      expect.arrayContaining([checkpoint.snapshotSha256])
    );
    expect(store.authoritativeStatus()).toMatchObject({
      mode: "postgres-s3",
      cacheDurable: false,
    });

    await store.closeAuthoritative();
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(root)).toBe(false);
  });

  test("remote mode is explicit and cannot be inferred from PostgreSQL alone", () => {
    expect(remoteStoreEnabled({ ATHENA_DATABASE_PROVIDER: "postgresql" })).toBe(
      false
    );
    expect(
      remoteStoreEnabled({ ATHENA_CRYPTO_FORECAST_STORE: "postgres-s3" })
    ).toBe(true);
  });
});
