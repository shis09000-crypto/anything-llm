/* eslint-env jest */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  CryptoForecastStore,
} = require("../../../utils/cryptoForecasting/store");

function bar(overrides = {}) {
  return {
    symbol: "BTC",
    interval: "5m",
    openTimeMs: 1_700_000_000_000,
    closeTimeMs: 1_700_000_299_999,
    open: 100,
    high: 102,
    low: 99,
    close: 101,
    volume: 10,
    quoteVolume: 1_000,
    tradeCount: 50,
    takerBuyBaseVolume: 6,
    takerBuyQuoteVolume: 600,
    source: "test",
    ...overrides,
  };
}

describe("CryptoForecastStore", () => {
  let root;
  let store;
  let now;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "crypto-forecast-store-"));
    now = 1_800_000_000_000;
    store = new CryptoForecastStore({ root, now: () => now });
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("upserts bars idempotently and preserves chronological reads", () => {
    expect(
      store.upsertBars([
        bar(),
        bar({
          openTimeMs: 1_700_000_300_000,
          closeTimeMs: 1_700_000_599_999,
          close: 103,
        }),
      ])
    ).toBe(2);
    store.upsertBars([bar({ close: 104 })]);

    expect(store.bars({ symbol: "BTC", interval: "5m" })).toEqual([
      expect.objectContaining({ openTimeMs: 1_700_000_000_000, close: 104 }),
      expect.objectContaining({ openTimeMs: 1_700_000_300_000, close: 103 }),
    ]);
    expect(store.latestBar("BTC", "5m")).toMatchObject({
      openTimeMs: 1_700_000_300_000,
      availableAtMs: 1_700_000_600_000,
      availabilityEstimated: true,
    });
  });

  it("enforces availableAt in point-in-time reads", () => {
    store.upsertBars([
      bar({
        availableAtMs: 1_800_000_000_100,
        availabilityEstimated: false,
        receivedAtMs: 1_800_000_000_100,
      }),
    ]);
    expect(
      store.barsAvailableAt({
        symbol: "BTC",
        interval: "5m",
        decisionAtMs: 1_800_000_000_099,
      })
    ).toEqual([]);
    expect(
      store.barsAvailableAt({
        symbol: "BTC",
        interval: "5m",
        decisionAtMs: 1_800_000_000_100,
      })
    ).toHaveLength(1);
  });

  it("serializes a lease and permits takeover only after expiry", () => {
    expect(
      store.acquireLease({ name: "collector", ownerId: "a", ttlMs: 1_000 })
    ).toBe(true);
    expect(
      store.acquireLease({ name: "collector", ownerId: "b", ttlMs: 1_000 })
    ).toBe(false);
    now += 1_001;
    expect(
      store.acquireLease({ name: "collector", ownerId: "b", ttlMs: 1_000 })
    ).toBe(true);
  });

  it("records and resolves a prediction without duplicating its idempotency key", () => {
    const prediction = {
      predictionId: "prediction-1",
      symbol: "BTC",
      horizon: "4h",
      asOfMs: now,
      outcomeDueMs: now + 4 * 60 * 60 * 1_000,
      modelVersion: "model-1",
      featureSchemaVersion: "features-1",
      status: "shadow",
      payload: { candidateState: "up", labelBandRatio: 0.01 },
    };
    store.recordPrediction(prediction);
    store.recordPrediction({ ...prediction, predictionId: "prediction-2" });

    expect(store.latestPrediction("BTC", "4h")).toMatchObject({
      predictionId: "prediction-1",
      payload: { candidateState: "up" },
    });
    now = prediction.outcomeDueMs;
    expect(store.unresolvedPredictions(now)).toHaveLength(1);
    store.resolvePrediction("prediction-1", { actualState: "up" });
    expect(store.unresolvedPredictions(now)).toHaveLength(0);
    expect(store.prediction("prediction-1")).toMatchObject({
      outcome: { actualState: "up" },
      passportStatus: "legacy_partial",
    });
  });

  it("selects the newest model when versions share the same market as-of time", () => {
    const common = {
      symbol: "BTC",
      horizon: "4h",
      asOfMs: now,
      outcomeDueMs: now + 4 * 60 * 60 * 1_000,
      featureSchemaVersion: "features-1",
      status: "shadow",
    };
    store.recordPrediction({
      ...common,
      predictionId: "v1-prediction",
      modelVersion: "model-v1",
      payload: { modelVersion: "model-v1" },
    });
    now += 1;
    store.recordPrediction({
      ...common,
      predictionId: "v2-prediction",
      modelVersion: "model-v2",
      payload: { modelVersion: "model-v2" },
    });
    expect(store.latestPrediction("BTC", "4h")).toMatchObject({
      predictionId: "v2-prediction",
      modelVersion: "model-v2",
    });
  });

  it("deduplicates registry, feature and cost evidence for a replayable passport", () => {
    const registry = { registryVersion: "features-v2", features: [] };
    store.saveFeatureRegistry({
      registrySha256: "registry",
      registryVersion: "features-v2",
      registry,
    });
    store.saveFeatureSnapshot({
      snapshotSha256: "snapshot",
      featureRegistrySha256: "registry",
      featureSchemaVersion: "features-v1",
      vector: [1, 2],
      metadata: { missing: [] },
    });
    store.saveCostModel({
      costModelSha256: "cost",
      costModelVersion: "cost-v1",
      costModel: { feeBps: 10 },
    });
    store.recordPrediction({
      predictionId: "passport-prediction",
      symbol: "BTC",
      horizon: "4h",
      asOfMs: now,
      outcomeDueMs: now + 1,
      modelVersion: "model-passport",
      featureSchemaVersion: "features-v1",
      status: "shadow",
      payload: {
        asOfMs: now,
        passport: {
          schema: "athena.crypto.prediction-passport",
          featureRegistrySha256: "registry",
          featureSnapshotSha256: "snapshot",
          costModelSha256: "cost",
        },
      },
    });
    expect(store.predictionPassport("passport-prediction")).toMatchObject({
      passportStatus: "complete",
      passport: {
        featureRegistry: { sha256: "registry" },
        featureSnapshot: { sha256: "snapshot", vector: [1, 2] },
        costModel: { sha256: "cost" },
      },
    });
  });

  it("reports bounded capacity without depending on production thresholds", () => {
    expect(
      store.capacity({
        maxStoreBytes: Number.MAX_SAFE_INTEGER,
        minFreeBytes: 0,
      })
    ).toMatchObject({
      allowed: true,
      reason: null,
      storageBytes: expect.any(Number),
      freeBytes: expect.any(Number),
    });
    expect(store.capacity({ maxStoreBytes: 1, minFreeBytes: 0 })).toMatchObject(
      {
        allowed: false,
        reason: "store_limit_reached",
      }
    );
  });

  it("exports a consistent read-only training snapshot with a digest", async () => {
    store.upsertBars([bar()]);
    const destination = path.join(os.tmpdir(), `forecast-${Date.now()}.db`);
    try {
      const snapshot = await store.exportReadOnlySnapshot(destination);
      expect(snapshot).toMatchObject({
        path: destination,
        bytes: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        summary: {
          bars: [
            expect.objectContaining({
              symbol: "BTC",
              interval: "5m",
              rows: 1,
            }),
          ],
        },
      });
      expect(fs.statSync(destination).mode & 0o777).toBe(0o400);
    } finally {
      fs.rmSync(destination, { force: true });
    }
  });

  it("preserves candidate feature availability time to prevent future leakage", () => {
    store.recordCandidateObservation({
      source: "gate_funding",
      symbol: "BTC",
      observedAtMs: 1_700_000_000_000,
      availableAtMs: 1_700_000_100_000,
      status: "candidate",
      payload: { rate: 0.0001 },
    });
    expect(
      store.candidateObservations({
        source: "gate_funding",
        symbol: "BTC",
        availableByMs: 1_700_000_099_999,
      })
    ).toEqual([]);
    expect(
      store.candidateObservations({
        source: "gate_funding",
        symbol: "BTC",
        availableByMs: 1_700_000_100_000,
      })
    ).toEqual([
      expect.objectContaining({
        observedAtMs: 1_700_000_000_000,
        availableAtMs: 1_700_000_100_000,
        payload: { rate: 0.0001 },
      }),
    ]);
  });
});
