/* eslint-env jest */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  FEATURE_NAMES,
  MIN_BARS,
} = require("../../../utils/cryptoForecasting/features");
const {
  ForecastModelRuntime,
  _internals,
  resolvePaperOutcome,
} = require("../../../utils/cryptoForecasting/modelRuntime");
const {
  FEATURE_REGISTRY_SHA256,
} = require("../../../utils/cryptoForecasting/contracts");

function bars(count = MIN_BARS + 5) {
  const start = 1_700_000_000_000;
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.01;
    return {
      symbol: "BTC",
      interval: "5m",
      openTimeMs: start + index * 300_000,
      closeTimeMs: start + (index + 1) * 300_000 - 1,
      open: close - 0.01,
      high: close + 0.1,
      low: close - 0.1,
      close,
      volume: 10,
      quoteVolume: close * 10,
      tradeCount: 100,
      takerBuyBaseVolume: 6,
      takerBuyQuoteVolume: close * 6,
      source: "test",
    };
  });
}

describe("ForecastModelRuntime", () => {
  let root;
  let active;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "forecast-model-runtime-"));
    active = path.join(root, "models", "active");
    fs.mkdirSync(active, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeManifest(rolloutStatus = "shadow", { withHeads = false } = {}) {
    const horizons = {};
    for (const horizon of ["4h", "24h", "4d", "12d", "24d"]) {
      const artifact = `${horizon}.onnx`;
      const data = Buffer.from(`fake-${horizon}`);
      fs.writeFileSync(path.join(active, artifact), data);
      horizons[horizon] = {
        artifact,
        artifactSha256: crypto.createHash("sha256").update(data).digest("hex"),
        inputName: "features",
        outputName: "probabilities",
        classOrder: ["down", "range", "up"],
        calibration: { scale: [1, 1, 1], bias: [0, 0, 0] },
        thresholds: {
          default: 0.5,
          margin: 0.1,
          minEvidenceCoverage: 0.9,
          maxDataFreshnessMs: 600_000,
        },
        featureMedians: Array(FEATURE_NAMES.length).fill(0),
        driverFeatureIndexes: [3, 4],
        runtimeContract: {
          featureVector: Array(FEATURE_NAMES.length).fill(0),
          expectedRawProbabilities: [0.1, 0.2, 0.7],
          maxAbsoluteDelta: 0.00001,
        },
      };
      if (withHeads && horizon === "4h") {
        const artifacts = {};
        for (const [name, value] of [
          ["q10", -0.02],
          ["q50", 0.01],
          ["q90", 0.04],
        ]) {
          const headArtifact = `${horizon}.return-${name}.onnx`;
          const headData = Buffer.from(`fake-${horizon}-${name}`);
          fs.writeFileSync(path.join(active, headArtifact), headData);
          artifacts[name] = {
            artifact: headArtifact,
            artifactSha256: crypto
              .createHash("sha256")
              .update(headData)
              .digest("hex"),
            inputName: "features",
            outputName: "variable",
            runtimeContract: {
              featureVector: Array(FEATURE_NAMES.length).fill(0),
              expectedRawValue: value,
              maxAbsoluteDelta: 0.00001,
            },
          };
        }
        const volArtifact = `${horizon}.future-volatility.onnx`;
        const volData = Buffer.from(`fake-${horizon}-vol`);
        fs.writeFileSync(path.join(active, volArtifact), volData);
        horizons[horizon].predictionHeads = {
          returnQuantiles: {
            status: "shadow",
            artifacts,
            conformalCorrection: {
              lower: -0.005,
              median: 0,
              upper: 0.005,
            },
          },
          futureVolatility: {
            status: "shadow",
            artifact: volArtifact,
            artifactSha256: crypto
              .createHash("sha256")
              .update(volData)
              .digest("hex"),
            inputName: "features",
            outputName: "variable",
            runtimeContract: {
              featureVector: Array(FEATURE_NAMES.length).fill(0),
              expectedRawValue: 0.03,
              maxAbsoluteDelta: 0.00001,
            },
          },
        };
      }
    }
    const manifest = {
      schema: "athena.crypto.forecast-model",
      schemaVersion: "1.0",
      modelVersion: "test-model",
      featureSchemaVersion: "crypto-forecast-features-v1",
      featureNames: FEATURE_NAMES,
      rolloutStatus,
      horizons,
    };
    fs.writeFileSync(
      path.join(active, "manifest.json"),
      JSON.stringify(manifest)
    );
    fs.writeFileSync(
      path.join(active, "manifest.signature.json"),
      JSON.stringify({})
    );
    return manifest;
  }

  it("rejects feature-order drift in a model manifest", () => {
    const manifest = writeManifest();
    expect(
      _internals.validateManifest({
        ...manifest,
        featureNames: [...FEATURE_NAMES].reverse(),
      })
    ).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["feature_order_mismatch"]),
    });
  });

  it("rejects a declared registry SHA that differs from the runtime contract", () => {
    const manifest = writeManifest();
    expect(
      _internals.validateManifest({
        ...manifest,
        featureRegistrySha256: "0".repeat(64),
      })
    ).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["feature_registry_mismatch"]),
    });
    expect(
      _internals.validateManifest({
        ...manifest,
        featureRegistrySha256: FEATURE_REGISTRY_SHA256,
      })
    ).toMatchObject({ valid: true });
  });

  it("loads a shadow model but forces a public abstention", async () => {
    writeManifest("shadow");
    const sessionFactory = jest.fn(async () => ({
      createTensor: (vector) => vector,
      run: async () => ({
        probabilities: { data: Float32Array.from([0.1, 0.2, 0.7]) },
      }),
    }));
    const runtime = new ForecastModelRuntime({
      root,
      env: { NODE_ENV: "test" },
      sessionFactory,
    });
    const source = bars();
    const result = await runtime.forecast({
      symbol: "BTC",
      horizon: "4h",
      bars: source,
      btcBars: source,
      asOfMs: source.at(-1).closeTimeMs,
      dataFreshnessMs: 1_000,
    });

    expect(sessionFactory).toHaveBeenCalledTimes(5);
    expect(result).toMatchObject({
      status: "shadow",
      candidateState: "up",
      predictedState: null,
      abstained: true,
      abstainReasons: expect.arrayContaining(["model_shadow"]),
      probabilities: {
        down: expect.closeTo(0.1, 5),
        range: expect.closeTo(0.2, 5),
        up: expect.closeTo(0.7, 5),
      },
    });
    expect(result.drivers).toHaveLength(2);
  });

  it("keeps active low-confidence output abstained", async () => {
    const manifest = writeManifest("active");
    for (const horizon of Object.keys(manifest.horizons))
      manifest.horizons[horizon].thresholds.default = 0.8;
    fs.writeFileSync(
      path.join(active, "manifest.json"),
      JSON.stringify(manifest)
    );
    const runtime = new ForecastModelRuntime({
      root,
      env: { NODE_ENV: "test" },
      sessionFactory: async () => ({
        createTensor: (vector) => vector,
        run: async () => ({
          probabilities: { data: Float32Array.from([0.2, 0.25, 0.55]) },
        }),
      }),
    });
    const source = bars();
    await expect(
      runtime.forecast({
        symbol: "BTC",
        horizon: "4h",
        bars: source,
        btcBars: source,
        asOfMs: source.at(-1).closeTimeMs,
      })
    ).resolves.toMatchObject({
      status: "active",
      predictedState: null,
      abstained: true,
      abstainReasons: expect.arrayContaining(["low_confidence"]),
    });
  });

  it("runs optional quantile and volatility heads without changing direction probabilities", async () => {
    writeManifest("shadow", { withHeads: true });
    const runtime = new ForecastModelRuntime({
      root,
      env: { NODE_ENV: "test" },
      sessionFactory: async (artifactPath) => ({
        createTensor: (vector) => vector,
        run: async () => {
          if (artifactPath.includes("return-q10"))
            return { variable: { data: Float32Array.from([-0.02]) } };
          if (artifactPath.includes("return-q50"))
            return { variable: { data: Float32Array.from([0.01]) } };
          if (artifactPath.includes("return-q90"))
            return { variable: { data: Float32Array.from([0.04]) } };
          if (artifactPath.includes("future-volatility"))
            return { variable: { data: Float32Array.from([0.03]) } };
          return {
            probabilities: { data: Float32Array.from([0.1, 0.2, 0.7]) },
          };
        },
      }),
    });
    const source = bars();
    const result = await runtime.forecast({
      symbol: "BTC",
      horizon: "4h",
      bars: source,
      btcBars: source,
      asOfMs: source.at(-1).closeTimeMs,
    });
    expect(result).toMatchObject({
      probabilities: {
        down: expect.closeTo(0.1, 5),
        range: expect.closeTo(0.2, 5),
        up: expect.closeTo(0.7, 5),
      },
      returnQuantiles: {
        status: "shadow",
        q10: expect.closeTo(-0.025, 5),
        q50: expect.closeTo(0.01, 5),
        q90: expect.closeTo(0.045, 5),
      },
      futureVolatility: {
        status: "shadow",
        realizedVolatility: expect.closeTo(0.03, 5),
      },
      currentRegime: {
        ruleVersion: "deterministic-regime-v1",
      },
    });
  });

  it("loads the last verified model directory when active is invalid", async () => {
    const manifest = writeManifest("shadow");
    const previous = path.join(root, "models", "previous");
    fs.cpSync(active, previous, { recursive: true });
    fs.writeFileSync(
      path.join(active, "manifest.json"),
      JSON.stringify({
        ...manifest,
        featureNames: [...FEATURE_NAMES].reverse(),
      })
    );
    const runtime = new ForecastModelRuntime({
      root,
      env: { NODE_ENV: "test" },
      sessionFactory: async () => ({
        createTensor: (vector) => vector,
        run: async () => ({
          probabilities: { data: Float32Array.from([0.2, 0.3, 0.5]) },
        }),
      }),
    });

    await expect(runtime.load()).resolves.toMatchObject({
      manifest: { modelVersion: "test-model" },
      modelRoot: previous,
    });
    expect(runtime.snapshot()).toMatchObject({
      loaded: true,
      modelSource: "previous",
      errorCode: "forecast_model_manifest_invalid",
    });
  });

  it("accounts for actual public funding in a simulated perpetual short", () => {
    const outcome = resolvePaperOutcome({
      prediction: {
        payload: {
          candidateState: "down",
          labelBandRatio: 0.0024,
          costModelVersion: "crypto-cost-model-v3",
        },
      },
      entryBar: { openTimeMs: 100, open: 100 },
      exitBar: { closeTimeMs: 200, close: 90 },
      shortEntryBar: { openTimeMs: 100, open: 101 },
      shortExitBar: { closeTimeMs: 200, close: 91 },
      fundingCostRatio: -0.0002,
      fundingCoverage: 1,
    });
    expect(outcome).toMatchObject({
      actualState: "down",
      candidateState: "down",
      correct: true,
      fundingRatio: -0.0002,
      fundingCoverage: 1,
      executionMarket: "binance_usdm_perpetual",
    });
    expect(outcome.grossReturn).toBeCloseTo((101 - 91) / 101);
    expect(outcome.netReturn).toBeCloseTo((101 - 91) / 101 - 0.0024 + 0.0002);
  });
});
