const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { verifyAgentManifest } = require("../security/agentManifestSignature");
const {
  FEATURE_SCHEMA_VERSION,
  FEATURE_SCHEMA_VERSION_V3,
  FEATURE_SCHEMA_VERSION_V4,
  FEATURE_SCHEMA_VERSION_V5,
  HORIZONS,
  MODEL_SCHEMA,
  MODEL_SCHEMA_VERSION,
  PAPER_NOTIONAL_USDT,
  ROUND_TRIP_COST_RATIO,
  forecastingRoot,
} = require("./constants");
const {
  FEATURE_NAMES,
  HORIZON_FEATURE_NAMES_V3,
  HORIZON_FEATURE_NAMES_V4,
  HORIZON_FEATURE_NAMES_V5,
  buildFeatureVector,
  buildFeatureVectorV3,
  buildFeatureVectorV4,
  buildFeatureVectorV5,
  costFirstTouchBarrierRatio,
  labelBandRatio,
} = require("./features");
const {
  FEATURE_REGISTRY_SHA256,
  FEATURE_REGISTRY,
  FEATURE_REGISTRY_V3,
  FEATURE_REGISTRY_V3_SHA256,
  FEATURE_REGISTRY_V4,
  FEATURE_REGISTRY_V4_SHA256,
  FEATURE_REGISTRY_V5,
  FEATURE_REGISTRY_V5_SHA256,
} = require("./contracts");

function sha256File(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function softmax(values) {
  const max = Math.max(...values);
  const exponentials = values.map((value) => Math.exp(value - max));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  return exponentials.map((value) => value / total);
}

function calibrateProbabilities(probabilities, calibration = {}) {
  const epsilon = 1e-12;
  const scale = Array.isArray(calibration.scale)
    ? calibration.scale
    : [1, 1, 1];
  const bias = Array.isArray(calibration.bias) ? calibration.bias : [0, 0, 0];
  const logits = probabilities.map(
    (probability, index) =>
      Math.log(Math.max(epsilon, Number(probability) || epsilon)) *
        Number(scale[index] ?? 1) +
      Number(bias[index] ?? 0)
  );
  return softmax(logits);
}

function calibrateBinary(probability, calibration = {}) {
  const clipped = Math.min(1 - 1e-12, Math.max(1e-12, Number(probability)));
  const logit = Math.log(clipped / (1 - clipped));
  const adjusted =
    logit * Number(calibration.scale ?? 1) + Number(calibration.bias ?? 0);
  return 1 / (1 + Math.exp(-adjusted));
}

function normalizeBinaryProbability(output) {
  const value = output?.data || output;
  const array = Array.from(value || []).map(Number);
  if (!array.length || !array.every(Number.isFinite))
    throw new Error("forecast_binary_output_invalid");
  if (array.length >= 2) {
    const pair = array.slice(-2);
    const total = pair[0] + pair[1];
    if (pair.every((item) => item >= 0) && total > 0) return pair[1] / total;
    return softmax(pair)[1];
  }
  const scalar = array[0];
  return scalar >= 0 && scalar <= 1 ? scalar : 1 / (1 + Math.exp(-scalar));
}

function normalizeProbabilities(output) {
  const value = output?.data || output;
  const array = Array.from(value || []).map(Number);
  if (array.length < 3 || !array.slice(-3).every(Number.isFinite))
    throw new Error("forecast_model_output_invalid");
  const last = array.slice(-3);
  const total = last.reduce((sum, item) => sum + item, 0);
  if (last.every((item) => item >= 0) && total > 0)
    return last.map((item) => item / total);
  return softmax(last);
}

function normalizeScalar(output) {
  const value = output?.data || output;
  const first = Number(Array.from(value || [])[0]);
  if (!Number.isFinite(first)) throw new Error("forecast_head_output_invalid");
  return first;
}

function optionalHeadArtifacts(entry) {
  const heads = entry?.predictionHeads || {};
  const artifacts = [];
  for (const [quantile, artifact] of Object.entries(
    heads.returnQuantiles?.artifacts || {}
  ))
    artifacts.push({
      key: `returnQuantiles:${quantile}`,
      ...artifact,
    });
  if (heads.futureVolatility?.artifact)
    artifacts.push({
      key: "futureVolatility",
      outputKind: "scalar",
      ...heads.futureVolatility,
    });
  for (const [quantile, artifact] of Object.entries(
    heads.futureVolatility?.artifacts || {}
  ))
    artifacts.push({
      key: `futureVolatility:${quantile}`,
      outputKind: "scalar",
      ...artifact,
    });
  if (heads.marketState?.artifact)
    artifacts.push({
      key: "marketState",
      outputKind: "multiclass",
      ...heads.marketState,
    });
  if (heads.tailRisk?.artifact)
    artifacts.push({
      key: "tailRisk",
      outputKind: "binary",
      ...heads.tailRisk,
    });
  return artifacts;
}

function decisionLayerArtifacts(entry) {
  if (entry?.decisionLayers) {
    if (entry.decisionLayers.side && entry.decisionLayers.tradeabilityMeta)
      return [
        { key: "side", ...entry.decisionLayers.side },
        {
          key: "tradeabilityMeta",
          ...entry.decisionLayers.tradeabilityMeta,
        },
      ];
    return [
      { key: "opportunity", ...entry.decisionLayers.opportunity },
      {
        key: "conditionalDirection",
        ...entry.decisionLayers.conditionalDirection,
      },
    ];
  }
  return [{ key: "direction", ...entry }];
}

function featureNamesForEntry(manifest, horizon, entry) {
  if (Array.isArray(entry?.featureNames)) return entry.featureNames;
  if (manifest?.featureSchemaVersion === FEATURE_SCHEMA_VERSION_V5)
    return HORIZON_FEATURE_NAMES_V5[horizon] || [];
  if (manifest?.featureSchemaVersion === FEATURE_SCHEMA_VERSION_V3)
    return HORIZON_FEATURE_NAMES_V3[horizon] || [];
  if (manifest?.featureSchemaVersion === FEATURE_SCHEMA_VERSION_V4)
    return HORIZON_FEATURE_NAMES_V4[horizon] || [];
  return FEATURE_NAMES;
}

function registryForEntry(manifest, entry) {
  if (
    entry?.featureRegistrySha256 === FEATURE_REGISTRY_V5_SHA256 ||
    (!entry?.featureRegistrySha256 &&
      manifest?.featureSchemaVersion === FEATURE_SCHEMA_VERSION_V5)
  )
    return {
      registry: FEATURE_REGISTRY_V5,
      sha256: FEATURE_REGISTRY_V5_SHA256,
    };
  if (
    entry?.featureRegistrySha256 === FEATURE_REGISTRY_V4_SHA256 ||
    (!entry?.featureRegistrySha256 &&
      manifest?.featureSchemaVersion === FEATURE_SCHEMA_VERSION_V4)
  )
    return {
      registry: FEATURE_REGISTRY_V4,
      sha256: FEATURE_REGISTRY_V4_SHA256,
    };
  if (
    entry?.featureRegistrySha256 === FEATURE_REGISTRY_V3_SHA256 ||
    (!entry?.featureRegistrySha256 &&
      manifest?.featureSchemaVersion === FEATURE_SCHEMA_VERSION_V3)
  )
    return {
      registry: FEATURE_REGISTRY_V3,
      sha256: FEATURE_REGISTRY_V3_SHA256,
    };
  return { registry: FEATURE_REGISTRY, sha256: FEATURE_REGISTRY_SHA256 };
}

function deterministicRegime(values = {}) {
  const slope4h = Number(values.regression_slope_4h || 0);
  const slope24h = Number(values.regression_slope_24h || 0);
  const r2 = Number(values.regression_r2_24h || 0);
  const efficiency = Number(values.efficiency_ratio_24h || 0);
  const volatility = Number(values.realized_vol_24h || 0);
  if (volatility >= 0.01)
    return {
      state: "high_volatility",
      ruleVersion: "deterministic-regime-v1",
    };
  if (r2 >= 0.55 && efficiency >= 0.35 && slope4h > 0 && slope24h > 0)
    return { state: "trending_up", ruleVersion: "deterministic-regime-v1" };
  if (r2 >= 0.55 && efficiency >= 0.35 && slope4h < 0 && slope24h < 0)
    return {
      state: "trending_down",
      ruleVersion: "deterministic-regime-v1",
    };
  return { state: "range_or_mixed", ruleVersion: "deterministic-regime-v1" };
}

async function runSession(session, entry, vector) {
  let feeds;
  if (session.createTensor)
    feeds = { [entry.inputName || "features"]: session.createTensor(vector) };
  else {
    const ort = require("onnxruntime-node");
    feeds = {
      [entry.inputName || session.inputNames?.[0] || "features"]:
        new ort.Tensor("float32", Float32Array.from(vector), [
          1,
          vector.length,
        ]),
    };
  }
  return session.run(feeds);
}

function validateManifest(manifest) {
  const errors = [];
  if (manifest?.schema !== MODEL_SCHEMA) errors.push("invalid_schema");
  if (manifest?.schemaVersion !== MODEL_SCHEMA_VERSION)
    errors.push("invalid_schema_version");
  if (
    ![
      FEATURE_SCHEMA_VERSION,
      FEATURE_SCHEMA_VERSION_V3,
      FEATURE_SCHEMA_VERSION_V4,
      FEATURE_SCHEMA_VERSION_V5,
    ].includes(manifest?.featureSchemaVersion)
  )
    errors.push("invalid_feature_schema");
  const isV3 = manifest?.featureSchemaVersion === FEATURE_SCHEMA_VERSION_V3;
  const isV4 = manifest?.featureSchemaVersion === FEATURE_SCHEMA_VERSION_V4;
  const isV5 = manifest?.featureSchemaVersion === FEATURE_SCHEMA_VERSION_V5;
  const isOptimized = isV3 || isV4 || isV5;
  if (!isOptimized) {
    if (
      !Array.isArray(manifest?.featureNames) ||
      manifest.featureNames.join("\n") !== FEATURE_NAMES.join("\n")
    )
      errors.push("feature_order_mismatch");
    if (
      manifest?.featureRegistrySha256 &&
      manifest.featureRegistrySha256 !== FEATURE_REGISTRY_SHA256
    )
      errors.push("feature_registry_mismatch");
  }
  if (!manifest?.modelVersion) errors.push("missing_model_version");
  for (const horizon of Object.keys(HORIZONS)) {
    const entry = manifest?.horizons?.[horizon];
    if (!entry) {
      errors.push(`missing_horizon:${horizon}`);
      continue;
    }
    const featureNames = featureNamesForEntry(manifest, horizon, entry);
    const entryRegistry = registryForEntry(manifest, entry);
    const expectedFeatureNames =
      entryRegistry.sha256 === FEATURE_REGISTRY_V5_SHA256 &&
      HORIZON_FEATURE_NAMES_V5[horizon]
        ? HORIZON_FEATURE_NAMES_V5[horizon]
        : entryRegistry.sha256 === FEATURE_REGISTRY_V4_SHA256 &&
            HORIZON_FEATURE_NAMES_V4[horizon]
          ? HORIZON_FEATURE_NAMES_V4[horizon]
          : entryRegistry.sha256 === FEATURE_REGISTRY_V3_SHA256 &&
              HORIZON_FEATURE_NAMES_V3[horizon]
            ? HORIZON_FEATURE_NAMES_V3[horizon]
            : FEATURE_NAMES;
    const optimizedSubset =
      isOptimized && expectedFeatureNames !== FEATURE_NAMES
        ? featureNames.reduce(
            (state, name) => {
              const index = expectedFeatureNames.indexOf(name);
              return {
                valid: state.valid && index > state.previous,
                previous: index,
              };
            },
            { valid: true, previous: -1 }
          ).valid
        : featureNames.join("\n") === expectedFeatureNames.join("\n");
    if (!optimizedSubset || !featureNames.length)
      errors.push(`feature_order_mismatch:${horizon}`);
    const expectedRegistrySha256 = entryRegistry.sha256;
    const declaredRegistrySha256 =
      entry.featureRegistrySha256 ||
      (!isOptimized ? manifest.featureRegistrySha256 : null);
    if (
      (isOptimized && !declaredRegistrySha256) ||
      (declaredRegistrySha256 &&
        declaredRegistrySha256 !== expectedRegistrySha256)
    )
      errors.push(`feature_registry_mismatch:${horizon}`);
    if (
      !Array.isArray(entry.classOrder) ||
      entry.classOrder.join(",") !== "down,range,up"
    )
      errors.push(`invalid_class_order:${horizon}`);
    for (const artifact of decisionLayerArtifacts(entry)) {
      if (
        !artifact.artifact ||
        !/^[a-f0-9]{64}$/.test(artifact.artifactSha256 || "")
      )
        errors.push(`invalid_artifact:${horizon}:${artifact.key}`);
      const contract = artifact.runtimeContract;
      const binary = artifact.key !== "direction";
      const expectedFeatureCount = Array.isArray(artifact.inputFeatureNames)
        ? artifact.inputFeatureNames.length
        : featureNames.length;
      if (
        !Array.isArray(contract?.featureVector) ||
        contract.featureVector.length !== expectedFeatureCount ||
        !contract.featureVector.every(Number.isFinite) ||
        (binary
          ? !Number.isFinite(contract?.expectedRawProbability)
          : !Array.isArray(contract?.expectedRawProbabilities) ||
            contract.expectedRawProbabilities.length !== 3 ||
            !contract.expectedRawProbabilities.every(Number.isFinite))
      )
        errors.push(`invalid_runtime_contract:${horizon}:${artifact.key}`);
    }
    for (const head of optionalHeadArtifacts(entry)) {
      const contract = head.runtimeContract;
      const expectedValid =
        head.outputKind === "multiclass"
          ? Array.isArray(contract?.expectedRawProbabilities) &&
            contract.expectedRawProbabilities.length === 3 &&
            contract.expectedRawProbabilities.every(Number.isFinite)
          : head.outputKind === "binary"
            ? Number.isFinite(contract?.expectedRawProbability)
            : Number.isFinite(contract?.expectedRawValue);
      if (
        !head.artifact ||
        !/^[a-f0-9]{64}$/.test(head.artifactSha256 || "") ||
        !Array.isArray(contract?.featureVector) ||
        contract.featureVector.length !== featureNames.length ||
        !contract.featureVector.every(Number.isFinite) ||
        !expectedValid
      )
        errors.push(`invalid_prediction_head:${horizon}:${head.key}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

class ForecastModelRuntime {
  constructor({
    root = forecastingRoot(),
    env = process.env,
    sessionFactory = null,
    now = () => Date.now(),
  } = {}) {
    this.root = path.resolve(root);
    this.modelsRoot = path.join(this.root, "models");
    this.activeRoot = path.join(this.modelsRoot, "active");
    this.previousRoot = path.join(this.modelsRoot, "previous");
    this.env = env;
    this.sessionFactory = sessionFactory;
    this.now = now;
    this.loaded = null;
    this.loadError = null;
    this.sessions = new Map();
  }

  async createSession(artifactPath) {
    if (this.sessionFactory) return this.sessionFactory(artifactPath);
    const ort = require("onnxruntime-node");
    return ort.InferenceSession.create(artifactPath, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
    });
  }

  loadManifest(modelRoot = this.activeRoot) {
    const manifestPath = path.join(modelRoot, "manifest.json");
    const signaturePath = path.join(modelRoot, "manifest.signature.json");
    if (!fs.existsSync(manifestPath) || !fs.existsSync(signaturePath)) {
      const error = new Error("forecast_model_manifest_missing");
      error.code = "forecast_model_manifest_missing";
      throw error;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const signature = JSON.parse(fs.readFileSync(signaturePath, "utf8"));
    const validation = validateManifest(manifest);
    if (!validation.valid) {
      const error = new Error(validation.errors.join(","));
      error.code = "forecast_model_manifest_invalid";
      throw error;
    }
    const verification = verifyAgentManifest(manifest, signature, {
      env: this.env,
    });
    const signatureRequired =
      this.env.NODE_ENV === "production" ||
      this.env.ATHENA_CRYPTO_FORECAST_REQUIRE_SIGNATURE === "true";
    if (signatureRequired && !verification.valid) {
      const error = new Error(verification.reason);
      error.code = "forecast_model_signature_invalid";
      throw error;
    }
    for (const [horizon, entry] of Object.entries(manifest.horizons)) {
      for (const artifact of [
        ...decisionLayerArtifacts(entry),
        ...optionalHeadArtifacts(entry),
      ]) {
        const artifactPath = path.resolve(modelRoot, artifact.artifact);
        if (!artifactPath.startsWith(`${modelRoot}${path.sep}`)) {
          const error = new Error(
            `artifact_path_escape:${horizon}:${artifact.key}`
          );
          error.code = "forecast_model_artifact_invalid";
          throw error;
        }
        if (
          !fs.existsSync(artifactPath) ||
          sha256File(artifactPath) !== artifact.artifactSha256
        ) {
          const error = new Error(
            `artifact_hash_mismatch:${horizon}:${artifact.key}`
          );
          error.code = "forecast_model_artifact_invalid";
          throw error;
        }
      }
    }
    return {
      manifest,
      signature,
      manifestSha256: crypto
        .createHash("sha256")
        .update(fs.readFileSync(manifestPath))
        .digest("hex"),
      signatureValid: verification.valid,
      modelRoot,
    };
  }

  async load({ force = false } = {}) {
    if (this.loaded && !force) return this.loaded;
    try {
      let loaded;
      let activeError = null;
      try {
        loaded = this.loadManifest(this.activeRoot);
      } catch (error) {
        activeError = error;
        loaded = this.loadManifest(this.previousRoot);
      }
      const sessions = new Map();
      for (const [horizon, entry] of Object.entries(loaded.manifest.horizons)) {
        for (const artifact of decisionLayerArtifacts(entry))
          sessions.set(
            `${horizon}:${artifact.key}`,
            await this.createSession(
              path.join(loaded.modelRoot, artifact.artifact)
            )
          );
        for (const head of optionalHeadArtifacts(entry))
          sessions.set(
            `${horizon}:${head.key}`,
            await this.createSession(path.join(loaded.modelRoot, head.artifact))
          );
      }
      if (loaded.manifest.runtimeParityRequired === true) {
        for (const [horizon, entry] of Object.entries(
          loaded.manifest.horizons
        )) {
          for (const artifact of decisionLayerArtifacts(entry)) {
            const session = sessions.get(`${horizon}:${artifact.key}`);
            const output = await runSession(
              session,
              artifact,
              artifact.runtimeContract.featureVector
            );
            const preferred =
              output[artifact.outputName] ||
              output.probabilities ||
              output[session.outputNames?.at(-1)];
            const tolerance = Number(
              artifact.runtimeContract.maxAbsoluteDelta || 1e-5
            );
            if (artifact.key === "direction") {
              const actual = normalizeProbabilities(preferred);
              const expected =
                artifact.runtimeContract.expectedRawProbabilities;
              if (
                actual.some(
                  (value, index) =>
                    Math.abs(value - Number(expected[index])) > tolerance
                )
              ) {
                const error = new Error(`direction_parity_failed:${horizon}`);
                error.code = "forecast_model_runtime_contract_invalid";
                throw error;
              }
            } else {
              const actual = normalizeBinaryProbability(preferred);
              if (
                Math.abs(
                  actual -
                    Number(artifact.runtimeContract.expectedRawProbability)
                ) > tolerance
              ) {
                const error = new Error(
                  `${artifact.key}_parity_failed:${horizon}`
                );
                error.code = "forecast_model_runtime_contract_invalid";
                throw error;
              }
            }
          }
          for (const head of optionalHeadArtifacts(entry)) {
            const session = sessions.get(`${horizon}:${head.key}`);
            const output = await runSession(
              session,
              head,
              head.runtimeContract.featureVector
            );
            const preferred =
              output[head.outputName] ||
              output.probabilities ||
              output.variable ||
              output[session.outputNames?.at(-1)];
            const expected =
              head.outputKind === "multiclass"
                ? head.runtimeContract.expectedRawProbabilities
                : head.outputKind === "binary"
                  ? [head.runtimeContract.expectedRawProbability]
                  : [head.runtimeContract.expectedRawValue];
            const actual =
              head.outputKind === "multiclass"
                ? normalizeProbabilities(preferred)
                : head.outputKind === "binary"
                  ? [normalizeBinaryProbability(preferred)]
                  : [normalizeScalar(preferred)];
            const delta = Math.max(
              ...actual.map((value, index) =>
                Math.abs(value - Number(expected[index]))
              )
            );
            if (delta > Number(head.runtimeContract.maxAbsoluteDelta || 1e-5)) {
              const error = new Error(
                `prediction_head_parity_failed:${horizon}:${head.key}`
              );
              error.code = "forecast_model_runtime_contract_invalid";
              throw error;
            }
          }
        }
      }
      this.sessions = sessions;
      this.loaded = { ...loaded, loadedAt: new Date(this.now()).toISOString() };
      this.loadError = activeError;
      return this.loaded;
    } catch (error) {
      this.loadError = error;
      if (!this.loaded) throw error;
      return this.loaded;
    }
  }

  snapshot() {
    return {
      loaded: Boolean(this.loaded),
      modelVersion: this.loaded?.manifest?.modelVersion || null,
      manifestSha256: this.loaded?.manifestSha256 || null,
      signatureValid: this.loaded?.signatureValid || false,
      modelSource:
        this.loaded?.modelRoot === this.previousRoot
          ? "previous"
          : this.loaded
            ? "active"
            : null,
      loadedAt: this.loaded?.loadedAt || null,
      errorCode: this.loadError?.code || null,
      featureRegistrySha256:
        this.loaded?.manifest?.featureRegistrySha256 ||
        (this.loaded?.manifest?.featureSchemaVersion ===
        FEATURE_SCHEMA_VERSION_V5
          ? FEATURE_REGISTRY_V5_SHA256
          : this.loaded?.manifest?.featureSchemaVersion ===
              FEATURE_SCHEMA_VERSION_V4
            ? FEATURE_REGISTRY_V4_SHA256
            : this.loaded?.manifest?.featureSchemaVersion ===
                FEATURE_SCHEMA_VERSION_V3
              ? FEATURE_REGISTRY_V3_SHA256
              : FEATURE_REGISTRY_SHA256),
      featureRegistryCompatibility:
        this.loaded?.manifest?.featureSchemaVersion ===
          FEATURE_SCHEMA_VERSION_V5 ||
        this.loaded?.manifest?.featureSchemaVersion ===
          FEATURE_SCHEMA_VERSION_V4 ||
        this.loaded?.manifest?.featureSchemaVersion ===
          FEATURE_SCHEMA_VERSION_V3
          ? "strict_per_horizon"
          : this.loaded?.manifest?.featureRegistrySha256
            ? "strict"
            : "legacy_feature_order",
    };
  }

  async rawProbabilities(horizon, vector) {
    const entry = this.loaded.manifest.horizons[horizon];
    const session = this.sessions.get(`${horizon}:direction`);
    if (!entry || !session)
      throw new Error("forecast_model_horizon_unavailable");
    const outputs = await runSession(session, entry, vector);
    const preferred =
      outputs[entry.outputName] ||
      outputs.probabilities ||
      outputs[session.outputNames?.at(-1)];
    return normalizeProbabilities(preferred);
  }

  async binaryLayerProbability(horizon, key, vector) {
    const entry = this.loaded.manifest.horizons[horizon]?.decisionLayers?.[key];
    const session = this.sessions.get(`${horizon}:${key}`);
    if (!entry || !session)
      throw new Error(`forecast_model_layer_unavailable:${key}`);
    const outputs = await runSession(session, entry, vector);
    return normalizeBinaryProbability(
      outputs[entry.outputName] ||
        outputs.probabilities ||
        outputs[session.outputNames?.at(-1)]
    );
  }

  async scalarHead(horizon, key, entry, vector) {
    const session = this.sessions.get(`${horizon}:${key}`);
    if (!session || !entry) return null;
    const outputs = await runSession(session, entry, vector);
    return normalizeScalar(
      outputs[entry.outputName] ||
        outputs.variable ||
        outputs[session.outputNames?.at(-1)]
    );
  }

  async optionalHeadProbability(
    horizon,
    key,
    entry,
    vector,
    multiclass = false
  ) {
    const session = this.sessions.get(`${horizon}:${key}`);
    if (!session || !entry) return null;
    const outputs = await runSession(session, entry, vector);
    const preferred =
      outputs[entry.outputName] ||
      outputs.probabilities ||
      outputs[session.outputNames?.at(-1)];
    return multiclass
      ? normalizeProbabilities(preferred)
      : normalizeBinaryProbability(preferred);
  }

  async predictionHeads(horizon, vector, values) {
    const heads = this.loaded.manifest.horizons[horizon]?.predictionHeads || {};
    let returnQuantiles = null;
    if (heads.returnQuantiles?.artifacts) {
      const correction = heads.returnQuantiles.conformalCorrection || {};
      const raw = {};
      for (const name of ["q10", "q50", "q90"]) {
        const entry = heads.returnQuantiles.artifacts[name];
        raw[name] = await this.scalarHead(
          horizon,
          `returnQuantiles:${name}`,
          entry,
          vector
        );
      }
      const ordered = [
        Number(raw.q10) + Number(correction.lower || 0),
        Number(raw.q50) + Number(correction.median || 0),
        Number(raw.q90) + Number(correction.upper || 0),
      ].sort((left, right) => left - right);
      returnQuantiles = {
        status: heads.returnQuantiles.status || "shadow",
        q10: Number(ordered[0].toFixed(8)),
        q50: Number(ordered[1].toFixed(8)),
        q90: Number(ordered[2].toFixed(8)),
        interpretation: "return_distribution_not_target_prices",
      };
    }
    let futureVolatility = null;
    if (heads.futureVolatility?.artifacts) {
      let p50 = await this.scalarHead(
        horizon,
        "futureVolatility:p50",
        heads.futureVolatility.artifacts.p50,
        vector
      );
      const rawP90 = await this.scalarHead(
        horizon,
        "futureVolatility:p90",
        heads.futureVolatility.artifacts.p90,
        vector
      );
      const blend = heads.futureVolatility.blend;
      const baseline = Number(values?.[blend?.baselineFeature]);
      const modelWeight = Number(blend?.modelWeight);
      if (
        Number.isFinite(baseline) &&
        Number.isFinite(modelWeight) &&
        modelWeight >= 0 &&
        modelWeight <= 1
      )
        p50 = modelWeight * p50 + (1 - modelWeight) * baseline;
      p50 = Math.max(0, p50);
      const p90 = Math.max(p50, Number(rawP90) || 0);
      futureVolatility = {
        status: heads.futureVolatility.status || "shadow",
        p50: Number(p50.toFixed(8)),
        p90: Number(p90.toFixed(8)),
        unit: "horizon_realized_log_return_volatility",
      };
    } else if (heads.futureVolatility?.artifact) {
      const raw = await this.scalarHead(
        horizon,
        "futureVolatility",
        heads.futureVolatility,
        vector
      );
      futureVolatility = {
        status: heads.futureVolatility.status || "shadow",
        realizedVolatility: Number(Math.max(0, raw).toFixed(8)),
      };
    }
    let marketState = null;
    if (heads.marketState?.artifact) {
      const raw = await this.optionalHeadProbability(
        horizon,
        "marketState",
        heads.marketState,
        vector,
        true
      );
      const probabilities = calibrateProbabilities(
        raw,
        heads.marketState.calibration
      );
      const classOrder = heads.marketState.classOrder || [
        "trend",
        "range",
        "stress",
      ];
      const selected = probabilities.indexOf(Math.max(...probabilities));
      marketState = {
        status: heads.marketState.status || "shadow",
        state: classOrder[selected],
        probabilities: Object.fromEntries(
          classOrder.map((name, index) => [
            name,
            Number(probabilities[index].toFixed(8)),
          ])
        ),
        modelVersion: heads.marketState.modelVersion || null,
      };
    }
    let tailRisk = null;
    if (heads.tailRisk?.artifact) {
      const raw = await this.optionalHeadProbability(
        horizon,
        "tailRisk",
        heads.tailRisk,
        vector
      );
      const probability = calibrateBinary(raw, heads.tailRisk.calibration);
      tailRisk = {
        status: heads.tailRisk.status || "shadow",
        probability: Number(probability.toFixed(8)),
        definition: heads.tailRisk.definition || "future_tail_event",
      };
    }
    return {
      returnQuantiles,
      futureVolatility,
      marketState,
      tailRisk,
      currentRegime: marketState || deterministicRegime(values),
    };
  }

  async probabilities(horizon, vector) {
    return (await this.probabilityDetails(horizon, vector)).probabilities;
  }

  async probabilityDetails(horizon, vector, { values = null } = {}) {
    const entry = this.loaded.manifest.horizons[horizon];
    if (!entry?.decisionLayers) {
      const raw = await this.rawProbabilities(horizon, vector);
      return {
        probabilities: calibrateProbabilities(raw, entry.calibration),
        decisionLayer: "multiclass-v2",
        actionProbability: null,
        conditionalDirectionProbability: null,
      };
    }
    if (entry.decisionLayers.side && entry.decisionLayers.tradeabilityMeta) {
      const rawSide = await this.binaryLayerProbability(
        horizon,
        "side",
        vector
      );
      const upGivenTrade = calibrateBinary(
        rawSide,
        entry.decisionLayers.side.calibration
      );
      const predictionHeads = await this.predictionHeads(
        horizon,
        vector,
        values ||
          Object.fromEntries(
            featureNamesForEntry(this.loaded.manifest, horizon, entry).map(
              (name, index) => [name, vector[index]]
            )
          )
      );
      const featureNames = featureNamesForEntry(
        this.loaded.manifest,
        horizon,
        entry
      );
      const baseValues = Object.fromEntries(
        featureNames.map((name, index) => [name, Number(vector[index]) || 0])
      );
      const derivedValues = {
        side_up_probability: upGivenTrade,
        future_volatility_p50:
          Number(
            predictionHeads.futureVolatility?.p50 ??
              predictionHeads.futureVolatility?.realizedVolatility
          ) || 0,
        tail_risk_probability:
          Number(predictionHeads.tailRisk?.probability) || 0,
        stress_probability:
          Number(predictionHeads.marketState?.probabilities?.stress) || 0,
      };
      const metaEntry = entry.decisionLayers.tradeabilityMeta;
      const metaFeatureNames = metaEntry.inputFeatureNames || [];
      const metaVector = metaFeatureNames.map((name) =>
        Number(derivedValues[name] ?? baseValues[name] ?? 0)
      );
      const rawTradeability = await this.binaryLayerProbability(
        horizon,
        "tradeabilityMeta",
        metaVector
      );
      const tradeabilityProbability = calibrateBinary(
        rawTradeability,
        metaEntry.calibration
      );
      const down = tradeabilityProbability * (1 - upGivenTrade);
      const range = 1 - tradeabilityProbability;
      const up = tradeabilityProbability * upGivenTrade;
      return {
        probabilities: [down, range, up],
        decisionLayer: "net_opportunity_then_side_v5",
        actionProbability: tradeabilityProbability,
        tradeabilityProbability,
        conditionalDirectionProbability: {
          down: 1 - upGivenTrade,
          up: upGivenTrade,
        },
        conditionalSideProbability: {
          down: 1 - upGivenTrade,
          up: upGivenTrade,
        },
        predictionHeads,
        metaVector,
      };
    }
    const rawAction = await this.binaryLayerProbability(
      horizon,
      "opportunity",
      vector
    );
    const rawUpGivenAction = await this.binaryLayerProbability(
      horizon,
      "conditionalDirection",
      vector
    );
    const actionProbability = calibrateBinary(
      rawAction,
      entry.decisionLayers.opportunity.calibration
    );
    const upGivenAction = calibrateBinary(
      rawUpGivenAction,
      entry.decisionLayers.conditionalDirection.calibration
    );
    const down = actionProbability * (1 - upGivenAction);
    const range = 1 - actionProbability;
    const up = actionProbability * upGivenAction;
    return {
      probabilities: [down, range, up],
      decisionLayer: "opportunity_then_direction-v1",
      actionProbability,
      conditionalDirectionProbability: {
        down: 1 - upGivenAction,
        up: upGivenAction,
      },
    };
  }

  referenceVector({ horizon, symbol, regime, vector }) {
    const entry = this.loaded.manifest.horizons[horizon];
    const references = entry.conditionalReferences || {};
    const selected =
      references.bySymbolRegime?.[symbol]?.[regime] ||
      references.bySymbol?.[symbol] ||
      references.global ||
      entry.featureMedians;
    return Array.isArray(selected) && selected.length === vector.length
      ? selected.map((value) => Number(value) || 0)
      : Array(vector.length).fill(0);
  }

  async drivers({
    horizon,
    symbol,
    values,
    vector,
    probabilities,
    predictedIndex,
  }) {
    const entry = this.loaded.manifest.horizons[horizon];
    const featureNames = featureNamesForEntry(
      this.loaded.manifest,
      horizon,
      entry
    );
    if (
      [
        "conditional_family_sensitivity_v1",
        "conditional_block_permutation_v2",
      ].includes(entry.driverMethod)
    ) {
      const regime = deterministicRegime(values).state;
      const reference = this.referenceVector({
        horizon,
        symbol,
        regime,
        vector,
      });
      const families = entry.driverFamilies || {};
      const deltas = [];
      for (const [family, indexes] of Object.entries(families)) {
        if (!Array.isArray(indexes) || !indexes.length) continue;
        const counterfactual = [...vector];
        for (const index of indexes)
          counterfactual[index] = Number(reference[index] || 0);
        const alternate = await this.probabilities(horizon, counterfactual);
        deltas.push({
          featurePath: `forecasting.featureFamilies.${family}`,
          featureFamily: family,
          featureIndexes: indexes,
          featureNames: indexes.map((index) => featureNames[index]),
          referenceCondition: { symbol, regime },
          counterfactualDelta:
            probabilities[predictedIndex] - alternate[predictedIndex],
          method: entry.driverMethod,
          causal: false,
        });
      }
      return deltas
        .sort(
          (left, right) =>
            Math.abs(right.counterfactualDelta) -
            Math.abs(left.counterfactualDelta)
        )
        .slice(0, 8)
        .map((driver) => ({
          ...driver,
          direction:
            driver.counterfactualDelta > 0
              ? "supports"
              : driver.counterfactualDelta < 0
                ? "conflicts"
                : "neutral",
          counterfactualDelta: Number(driver.counterfactualDelta.toFixed(8)),
        }));
    }
    const medians = Array.isArray(entry.featureMedians)
      ? entry.featureMedians
      : Array(featureNames.length).fill(0);
    const candidates = Array.isArray(entry.driverFeatureIndexes)
      ? entry.driverFeatureIndexes
      : featureNames.map((_, index) => index);
    const deltas = [];
    for (const index of candidates.slice(0, 24)) {
      const counterfactual = [...vector];
      counterfactual[index] = Number(medians[index] || 0);
      const alternate = await this.probabilities(horizon, counterfactual);
      deltas.push({
        featurePath: `forecasting.features.${featureNames[index]}`,
        featureIndex: index,
        value: vector[index],
        referenceValue: counterfactual[index],
        counterfactualDelta:
          probabilities[predictedIndex] - alternate[predictedIndex],
      });
    }
    return deltas
      .sort(
        (left, right) =>
          Math.abs(right.counterfactualDelta) -
          Math.abs(left.counterfactualDelta)
      )
      .slice(0, 8)
      .map((driver) => ({
        ...driver,
        direction:
          driver.counterfactualDelta > 0
            ? "supports"
            : driver.counterfactualDelta < 0
              ? "conflicts"
              : "neutral",
        counterfactualDelta: Number(driver.counterfactualDelta.toFixed(8)),
      }));
  }

  async forecast({
    symbol,
    horizon,
    bars,
    btcBars,
    marketBarsBySymbol,
    asOfMs,
    decisionAtMs = asOfMs,
    dataFreshnessMs = 0,
  }) {
    if (!HORIZONS[horizon]) throw new Error(`unsupported_horizon:${horizon}`);
    await this.load();
    const manifest = this.loaded.manifest;
    const horizonManifest = manifest.horizons[horizon];
    const entryRegistry = registryForEntry(manifest, horizonManifest);
    const useV5Features =
      horizonManifest.featureRegistrySha256 === FEATURE_REGISTRY_V5_SHA256;
    const useV3Features =
      horizonManifest.featureRegistrySha256 === FEATURE_REGISTRY_V3_SHA256;
    const useV4Features =
      horizonManifest.featureRegistrySha256 === FEATURE_REGISTRY_V4_SHA256;
    const featureNames = featureNamesForEntry(
      manifest,
      horizon,
      horizonManifest
    );
    const features = useV5Features
      ? buildFeatureVectorV5({
          horizon,
          symbol,
          bars,
          marketBarsBySymbol: marketBarsBySymbol || {
            BTC: btcBars,
            [symbol]: bars,
          },
          featureNames,
          asOfMs,
          decisionAtMs,
        })
      : useV4Features
        ? buildFeatureVectorV4({
            horizon,
            symbol,
            bars,
            marketBarsBySymbol: marketBarsBySymbol || {
              BTC: btcBars,
              [symbol]: bars,
            },
            featureNames,
            asOfMs,
            decisionAtMs,
          })
        : useV3Features
          ? buildFeatureVectorV3({
              horizon,
              symbol,
              bars,
              marketBarsBySymbol: marketBarsBySymbol || {
                BTC: btcBars,
                [symbol]: bars,
              },
              featureNames,
              asOfMs,
              decisionAtMs,
            })
          : buildFeatureVector({
              symbol,
              bars,
              btcBars,
              asOfMs,
              decisionAtMs,
            });
    if (!features.vector) {
      return {
        status: "abstained",
        modelVersion: manifest.modelVersion,
        featureSchemaVersion: manifest.featureSchemaVersion,
        asOfMs,
        decisionAtMs,
        probabilities: null,
        candidateState: null,
        predictedState: null,
        abstained: true,
        abstainReasons: [features.reason],
        evidenceCoverage: 0,
        dataFreshnessMs,
        drivers: [],
        features,
        featureSnapshot: {
          registrySha256: entryRegistry.sha256,
          registryVersion: entryRegistry.registry.registryVersion,
          values: null,
          vector: null,
          missing: featureNames,
          barsAvailable: features.barsAvailable || 0,
        },
      };
    }
    const probabilityDetails = await this.probabilityDetails(
      horizon,
      features.vector,
      { values: features.values }
    );
    const probabilities = probabilityDetails.probabilities;
    const classOrder = horizonManifest.classOrder;
    const rolloutStatus =
      horizonManifest.rolloutStatus || manifest.rolloutStatus || "shadow";
    const ranked = probabilities
      .map((probability, index) => ({ probability, index }))
      .sort((left, right) => right.probability - left.probability);
    const thresholds = horizonManifest.thresholds || {};
    const actionThreshold = Number(thresholds.minActionProbability ?? 1);
    const conditionalDirection =
      probabilityDetails.conditionalDirectionProbability;
    const candidateState = horizonManifest.decisionLayers
      ? Number(probabilityDetails.actionProbability) < actionThreshold
        ? "range"
        : Number(conditionalDirection?.up || 0) >=
            Number(conditionalDirection?.down || 0)
          ? "up"
          : "down"
      : classOrder[ranked[0].index];
    const candidateIndex = classOrder.indexOf(candidateState);
    const confidenceThreshold = Number(
      thresholds[candidateState] ?? thresholds.default ?? 1
    );
    const marginThreshold = Number(thresholds.margin ?? 0.1);
    const reasons = [];
    if (rolloutStatus !== "active") reasons.push("model_shadow");
    if (horizonManifest.decisionLayers) {
      const directionThreshold = Number(
        thresholds.minDirectionProbability ?? 1
      );
      const directionConfidence = Math.max(
        Number(probabilityDetails.conditionalDirectionProbability?.up || 0),
        Number(probabilityDetails.conditionalDirectionProbability?.down || 0)
      );
      if (Number(probabilityDetails.actionProbability) < actionThreshold)
        reasons.push("low_action_probability");
      if (
        Number(probabilityDetails.actionProbability) >= actionThreshold &&
        directionConfidence < directionThreshold
      )
        reasons.push("low_direction_confidence");
    } else {
      if (ranked[0].probability < confidenceThreshold)
        reasons.push("low_confidence");
      if (ranked[0].probability - ranked[1].probability < marginThreshold)
        reasons.push("low_probability_margin");
    }
    if (
      features.evidenceCoverage < Number(thresholds.minEvidenceCoverage ?? 0.9)
    )
      reasons.push("insufficient_feature_coverage");
    if (dataFreshnessMs > Number(thresholds.maxDataFreshnessMs ?? 10 * 60_000))
      reasons.push("stale_market_data");
    const drivers = await this.drivers({
      horizon,
      symbol,
      values: features.values,
      vector: features.vector,
      probabilities,
      predictedIndex: candidateIndex,
    });
    const predictionHeads =
      probabilityDetails.predictionHeads ||
      (await this.predictionHeads(horizon, features.vector, features.values));
    if (
      Number(predictionHeads.tailRisk?.probability) >
      Number(horizonManifest.thresholds?.maxTailRiskProbability ?? 1)
    )
      reasons.push("tail_risk_gate");
    const derivativesCoverage = horizonManifest.derivativesCoverage || null;
    if (
      candidateState === "down" &&
      Number(derivativesCoverage?.shortExecutionCoverage || 0) <
        Number(thresholds.minimumDerivativesCoverage ?? 0.95)
    )
      reasons.push("derivatives_coverage_insufficient");
    const executionGate = {
      eligible: reasons.length === 0,
      reasons: [...reasons],
      requiredCoverage: Number(thresholds.minimumDerivativesCoverage ?? 0.95),
      costModelVersion:
        horizonManifest.costModelVersion ||
        manifest.costModelVersion ||
        "crypto-cost-model-v1",
    };
    return {
      status: rolloutStatus === "active" ? "active" : "shadow",
      modelVersion: manifest.modelVersion,
      featureSchemaVersion: manifest.featureSchemaVersion,
      datasetManifestSha256: manifest.datasetManifestSha256 || null,
      modelArtifactSha256:
        horizonManifest.modelArtifactSha256 ||
        horizonManifest.artifactSha256 ||
        null,
      asOfMs,
      decisionAtMs,
      probabilities: Object.fromEntries(
        classOrder.map((name, index) => [
          name,
          Number(probabilities[index].toFixed(8)),
        ])
      ),
      candidateState,
      predictedState: reasons.length ? null : candidateState,
      abstained: reasons.length > 0,
      abstainReasons: reasons,
      evidenceCoverage: features.evidenceCoverage,
      dataFreshnessMs,
      drivers,
      decisionLayer: probabilityDetails.decisionLayer,
      actionProbability:
        probabilityDetails.actionProbability !== null &&
        probabilityDetails.actionProbability !== undefined &&
        Number.isFinite(Number(probabilityDetails.actionProbability))
          ? Number(probabilityDetails.actionProbability.toFixed(8))
          : null,
      tradeabilityProbability:
        probabilityDetails.tradeabilityProbability !== null &&
        probabilityDetails.tradeabilityProbability !== undefined &&
        Number.isFinite(Number(probabilityDetails.tradeabilityProbability))
          ? Number(probabilityDetails.tradeabilityProbability.toFixed(8))
          : null,
      conditionalDirectionProbability:
        probabilityDetails.conditionalDirectionProbability,
      conditionalSideProbability:
        probabilityDetails.conditionalSideProbability || null,
      labelPolicyVersion: horizonManifest.labelPolicyVersion || null,
      executionGate,
      derivativesCoverage,
      metaModelArtifactSha256:
        horizonManifest.decisionLayers?.tradeabilityMeta?.artifactSha256 ||
        null,
      selectivePolicyVersion:
        horizonManifest.selectivePolicyVersion ||
        (horizonManifest.decisionLayers ? "cost-adjusted-selective-v3" : null),
      costModelVersion:
        horizonManifest.costModelVersion ||
        manifest.costModelVersion ||
        "crypto-cost-model-v1",
      driverMethod:
        horizonManifest.driverMethod || "global_median_single_feature_v2",
      featureFamilyEligibility:
        horizonManifest.featureFamilyEligibility || null,
      dataFamilyCoverage: horizonManifest.dataFamilyCoverage || null,
      featureSelectionVersion: horizonManifest.featureSelectionVersion || null,
      validationProtocolVersion:
        horizonManifest.validationProtocolVersion || null,
      prospectiveEvidence: horizonManifest.prospectiveEvidence || {
        status: "not_started",
        settledNonOverlapping: 0,
      },
      ablationReportSha256: horizonManifest.ablationReportSha256 || null,
      ...predictionHeads,
      governanceState: rolloutStatus === "active" ? "active" : "shadow",
      featureDigestSha256: crypto
        .createHash("sha256")
        .update(JSON.stringify(features.values))
        .digest("hex"),
      featureSnapshot: {
        registrySha256: entryRegistry.sha256,
        registryVersion: entryRegistry.registry.registryVersion,
        values: features.values,
        vector: features.vector,
        missing: features.missing,
        barsAvailable: features.barsAvailable,
      },
      labelBandRatio: labelBandRatio(bars, HORIZONS[horizon].durationMs),
      labelBarrierRatio:
        horizonManifest.labelPolicyVersion === "cost-first-touch-v5"
          ? costFirstTouchBarrierRatio(
              bars,
              horizonManifest.labelContract?.selectedBarrierMultiplier,
              {
                horizonDurationMs: HORIZONS[horizon].durationMs,
                feeBpsPerSide: horizonManifest.labelContract?.feeBpsPerSide,
                slippageBpsPerSide:
                  horizonManifest.labelContract?.labelSlippageBpsPerSide,
                safetyBufferBps: horizonManifest.labelContract?.safetyBufferBps,
              }
            )
          : null,
    };
  }
}

function resolvePaperOutcome({
  prediction,
  entryBar,
  exitBar,
  shortEntryBar = null,
  shortExitBar = null,
  fundingCostRatio = 0,
  fundingCoverage = 0,
}) {
  const payload = prediction.payload;
  const entry = Number(entryBar?.open);
  const exit = Number(exitBar?.close);
  if (!(entry > 0 && exit > 0)) return null;
  const logReturn = Math.log(exit / entry);
  const band = Number(payload.labelBandRatio || ROUND_TRIP_COST_RATIO);
  const actualState =
    logReturn > band ? "up" : logReturn < -band ? "down" : "range";
  const candidate = payload.candidateState;
  const requiresPerpetualShort =
    candidate === "down" && payload.costModelVersion === "crypto-cost-model-v3";
  if (
    requiresPerpetualShort &&
    (!(Number(shortEntryBar?.open) > 0) || !(Number(shortExitBar?.close) > 0))
  )
    return null;
  const shortEntry = Number(shortEntryBar?.open || entry);
  const shortExit = Number(shortExitBar?.close || exit);
  const grossReturn =
    candidate === "up"
      ? exit / entry - 1
      : candidate === "down"
        ? (shortEntry - shortExit) / shortEntry
        : 0;
  const fundingRatio = Number(fundingCostRatio || 0);
  const netReturn =
    candidate === "range"
      ? 0
      : grossReturn - ROUND_TRIP_COST_RATIO - fundingRatio;
  return {
    entryTimeMs: entryBar.openTimeMs,
    exitTimeMs: exitBar.closeTimeMs,
    entryPrice: entry,
    exitPrice: exit,
    executionMarket:
      candidate === "down" && requiresPerpetualShort
        ? "binance_usdm_perpetual"
        : "binance_spot",
    executionEntryPrice: candidate === "down" ? shortEntry : entry,
    executionExitPrice: candidate === "down" ? shortExit : exit,
    actualState,
    candidateState: candidate,
    correct: candidate === actualState,
    grossReturn,
    costRatio: ROUND_TRIP_COST_RATIO,
    fundingRatio,
    fundingCoverage,
    netReturn,
    paperPnlUsdt: PAPER_NOTIONAL_USDT * netReturn,
  };
}

module.exports = {
  ForecastModelRuntime,
  _internals: {
    calibrateBinary,
    calibrateProbabilities,
    decisionLayerArtifacts,
    featureNamesForEntry,
    normalizeBinaryProbability,
    normalizeProbabilities,
    normalizeScalar,
    optionalHeadArtifacts,
    deterministicRegime,
    runSession,
    sha256File,
    softmax,
    validateManifest,
  },
  resolvePaperOutcome,
};
