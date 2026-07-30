#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const {
  signAgentManifest,
  verifyAgentManifest,
} = require("../utils/security/agentManifestSignature");
const { forecastingRoot } = require("../utils/cryptoForecasting/constants");
const {
  _internals: {
    decisionLayerArtifacts,
    normalizeBinaryProbability,
    normalizeProbabilities,
    normalizeScalar,
    optionalHeadArtifacts,
    sha256File,
    validateManifest,
  },
} = require("../utils/cryptoForecasting/modelRuntime");

function argument(name, fallback = null) {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function assertCandidate(candidate) {
  const manifestPath = path.join(candidate, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error("manifest_missing");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const validation = validateManifest(manifest);
  if (!validation.valid)
    throw new Error(`manifest_invalid:${validation.errors.join(",")}`);
  for (const [horizon, entry] of Object.entries(manifest.horizons)) {
    for (const artifactEntry of [
      ...decisionLayerArtifacts(entry),
      ...optionalHeadArtifacts(entry),
    ]) {
      const artifact = path.resolve(candidate, artifactEntry.artifact);
      if (!artifact.startsWith(`${candidate}${path.sep}`))
        throw new Error(`artifact_path_escape:${horizon}:${artifactEntry.key}`);
      if (!fs.existsSync(artifact))
        throw new Error(`artifact_missing:${horizon}:${artifactEntry.key}`);
      if (sha256File(artifact) !== artifactEntry.artifactSha256)
        throw new Error(
          `artifact_hash_mismatch:${horizon}:${artifactEntry.key}`
        );
    }
    if (
      entry.rolloutStatus === "active" &&
      (entry.eligibleForActive !== true ||
        entry.shadowObservationGate?.passed !== true)
    )
      throw new Error(`active_promotion_gate_failed:${horizon}`);
  }
  return { manifest, manifestPath };
}

function copyDirectory(source, target) {
  fs.cpSync(source, target, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
}

async function verifyRuntimeContracts(candidate, manifest) {
  const ort = require("onnxruntime-node");
  const results = {};
  for (const [horizon, entry] of Object.entries(manifest.horizons)) {
    results[horizon] = {};
    for (const artifactEntry of decisionLayerArtifacts(entry)) {
      const contract = artifactEntry.runtimeContract;
      if (!Array.isArray(contract?.featureVector))
        throw new Error(
          `runtime_contract_missing:${horizon}:${artifactEntry.key}`
        );
      const session = await ort.InferenceSession.create(
        path.join(candidate, artifactEntry.artifact),
        {
          executionProviders: ["cpu"],
          graphOptimizationLevel: "all",
          intraOpNumThreads: 1,
          interOpNumThreads: 1,
        }
      );
      const inputName =
        artifactEntry.inputName || session.inputNames?.[0] || "features";
      const outputName =
        artifactEntry.outputName ||
        session.outputNames?.at(-1) ||
        "probabilities";
      const outputs = await session.run({
        [inputName]: new ort.Tensor(
          "float32",
          Float32Array.from(contract.featureVector),
          [1, contract.featureVector.length]
        ),
      });
      let maxAbsoluteDelta;
      if (artifactEntry.key === "direction") {
        const actual = normalizeProbabilities(outputs[outputName]);
        const expected = contract.expectedRawProbabilities.map(Number);
        maxAbsoluteDelta = Math.max(
          ...actual.map((value, index) => Math.abs(value - expected[index]))
        );
      } else {
        const actual = normalizeBinaryProbability(outputs[outputName]);
        maxAbsoluteDelta = Math.abs(
          actual - Number(contract.expectedRawProbability)
        );
      }
      if (
        !Number.isFinite(maxAbsoluteDelta) ||
        maxAbsoluteDelta > Number(contract.maxAbsoluteDelta || 1e-5)
      )
        throw new Error(
          `runtime_contract_mismatch:${horizon}:${artifactEntry.key}`
        );
      results[horizon][artifactEntry.key] = maxAbsoluteDelta;
    }
    results[`${horizon}:heads`] = {};
    for (const head of optionalHeadArtifacts(entry)) {
      const headSession = await ort.InferenceSession.create(
        path.join(candidate, head.artifact),
        {
          executionProviders: ["cpu"],
          graphOptimizationLevel: "all",
          intraOpNumThreads: 1,
          interOpNumThreads: 1,
        }
      );
      const headContract = head.runtimeContract;
      const headOutput = await headSession.run({
        [head.inputName || headSession.inputNames?.[0] || "features"]:
          new ort.Tensor(
            "float32",
            Float32Array.from(headContract.featureVector),
            [1, headContract.featureVector.length]
          ),
      });
      const preferred =
        headOutput[head.outputName] ||
        headOutput.probabilities ||
        headOutput.variable ||
        headOutput[headSession.outputNames?.at(-1)];
      const actual =
        head.outputKind === "multiclass"
          ? normalizeProbabilities(preferred)
          : head.outputKind === "binary"
            ? [normalizeBinaryProbability(preferred)]
            : [normalizeScalar(preferred)];
      const expected =
        head.outputKind === "multiclass"
          ? headContract.expectedRawProbabilities
          : head.outputKind === "binary"
            ? [headContract.expectedRawProbability]
            : [headContract.expectedRawValue];
      const headDelta = Math.max(
        ...actual.map((value, index) =>
          Math.abs(value - Number(expected[index]))
        )
      );
      if (
        !Number.isFinite(headDelta) ||
        headDelta > Number(headContract.maxAbsoluteDelta || 1e-5)
      )
        throw new Error(
          `runtime_head_contract_mismatch:${horizon}:${head.key}`
        );
      results[`${horizon}:heads`][head.key] = headDelta;
    }
  }
  return results;
}

async function main() {
  const root = path.resolve(argument("root", forecastingRoot()));
  const candidate = path.resolve(argument("candidate", ""));
  if (!candidate || !candidate.startsWith(`${root}${path.sep}`))
    throw new Error("candidate_must_be_inside_forecasting_root");
  const { manifest } = assertCandidate(candidate);
  const runtimeContractDeltas = await verifyRuntimeContracts(
    candidate,
    manifest
  );
  const signature = signAgentManifest(manifest);
  const verification = verifyAgentManifest(manifest, signature);
  if (!verification.valid)
    throw new Error(`signature_self_check_failed:${verification.reason}`);
  const signaturePath = path.join(candidate, "manifest.signature.json");
  fs.writeFileSync(signaturePath, JSON.stringify(signature, null, 2), {
    mode: 0o600,
  });
  if (process.argv.includes("--promote")) {
    const modelsRoot = path.join(root, "models");
    const active = path.join(modelsRoot, "active");
    const next = path.join(modelsRoot, `.active-${process.pid}-next`);
    const previous = path.join(modelsRoot, "previous");
    if (fs.existsSync(next)) fs.rmSync(next, { recursive: true });
    copyDirectory(candidate, next);
    if (fs.existsSync(previous)) fs.rmSync(previous, { recursive: true });
    const hadActive = fs.existsSync(active);
    if (hadActive) fs.renameSync(active, previous);
    try {
      fs.renameSync(next, active);
    } catch (error) {
      if (hadActive && !fs.existsSync(active) && fs.existsSync(previous))
        fs.renameSync(previous, active);
      throw error;
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      signed: true,
      promoted: process.argv.includes("--promote"),
      modelVersion: manifest.modelVersion,
      rolloutStatus: manifest.rolloutStatus,
      signaturePath,
      runtimeContractDeltas,
    })}\n`
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify({ error: error?.code || error?.message || "sign_failed" })
  );
  process.exitCode = 1;
});
