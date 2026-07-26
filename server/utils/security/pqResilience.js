const crypto = require("crypto");
const os = require("os");
const path = require("path");
const { monitorEventLoopDelay, performance } = require("perf_hooks");
const { Worker } = require("worker_threads");
const { PURPOSES, SUITE_IDS, cryptoSuite } = require("./cryptoSuiteRegistry");
const {
  signHybridEnvelope,
  verifyHybridEnvelope,
} = require("./hybridSignature");
const {
  requiredPostQuantumFindings,
  runtimeCapabilities,
} = require("./cryptoRuntimeCapabilities");
const {
  deriveResilienceProbeKey,
  openResilienceProbe,
  sealResilienceProbe,
} = require("./keyCustody/resilienceProbe");

const RESILIENCE_FORMAT = "athena-pq-resilience:v1";
const MAX_ITERATIONS = 10_000;
const MAX_CONCURRENCY = 16;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const DEFAULT_THRESHOLDS = Object.freeze({
  p95Ms: 250,
  eventLoopP99Ms: 500,
  rssDeltaMiB: 512,
  minimumOperationsPerSecond: 10,
});

function boundedInteger(value, fallback, minimum, maximum, name) {
  const normalized = value === undefined ? fallback : Number(value);
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < minimum ||
    normalized > maximum
  ) {
    const error = new Error(`pq_resilience_${name}_invalid`);
    error.code = "PQ_RESILIENCE_INPUT_INVALID";
    throw error;
  }
  return normalized;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(Math.ceil(sorted.length * ratio) - 1, sorted.length - 1)
  ];
}

function publicRecord(suite, keyId, publicKey, extra = {}) {
  return {
    suiteId: suite.suiteId,
    keyId,
    publicKey: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
    ...extra,
  };
}

function hybridFixture() {
  const classicalSuite = cryptoSuite(SUITE_IDS.RELEASE_EVIDENCE_ED25519_V1, {
    purpose: PURPOSES.RELEASE_EVIDENCE,
  });
  const pqSuite = cryptoSuite(SUITE_IDS.RELEASE_EVIDENCE_MLDSA65_V1, {
    purpose: PURPOSES.RELEASE_EVIDENCE,
  });
  if (!classicalSuite || !pqSuite)
    throw new Error("pq_resilience_suite_unavailable");
  const classical = crypto.generateKeyPairSync("ed25519");
  const postQuantum = crypto.generateKeyPairSync("ml-dsa-65");
  const data = Buffer.from("athena-pq-resilience-envelope-v1");
  const policy = {
    threshold: 2,
    classicalRequired: true,
    pqRequired: true,
  };
  const envelope = signHybridEnvelope({
    data,
    policy,
    signers: [
      {
        suite: classicalSuite,
        keyId: "resilience-classical",
        ...classical,
        keyOrigin: "ephemeral-validation",
        hardwareProtection: "software-test",
      },
      {
        suite: pqSuite,
        keyId: "resilience-pq",
        ...postQuantum,
        keyOrigin: "ephemeral-validation",
        hardwareProtection: "software-test",
      },
    ],
  });
  const trustedKeys = [
    publicRecord(classicalSuite, "resilience-classical", classical.publicKey),
    publicRecord(pqSuite, "resilience-pq", postQuantum.publicKey),
  ];
  return { data, envelope, policy, trustedKeys };
}

function verifyHybrid({ data, envelope, policy, trustedKeys }) {
  return verifyHybridEnvelope({
    data,
    envelope,
    purpose: PURPOSES.RELEASE_EVIDENCE,
    trustedKeys,
    requirePolicy: policy,
  });
}

function expectRejected(name, operation, checks) {
  let rejected = false;
  try {
    rejected = operation() === true;
  } catch {
    rejected = true;
  }
  checks.push({ name, rejected });
}

function normalScenario({ iterations }) {
  const startedAt = performance.now();
  const runtime = runtimeCapabilities();
  const runtimeFindings = requiredPostQuantumFindings({
    required: true,
    runtimeMajor: Number(process.versions.node.split(".")[0]),
    capabilities: runtime,
  });
  if (runtimeFindings.length)
    throw new Error(
      `pq_resilience_runtime_failed:${runtimeFindings.join(",")}`
    );

  const fixture = hybridFixture();
  const latencies = [];
  for (let index = 0; index < iterations; index += 1) {
    const iterationStartedAt = performance.now();
    const result = verifyHybrid(fixture);
    if (!result.valid)
      throw new Error(
        `pq_resilience_hybrid_verification_failed:${result.findings.join(",")}`
      );
    const kem = crypto.generateKeyPairSync("ml-kem-768");
    const encapsulated = crypto.encapsulate(kem.publicKey);
    const recovered = crypto.decapsulate(
      kem.privateKey,
      encapsulated.ciphertext
    );
    if (!crypto.timingSafeEqual(encapsulated.sharedKey, recovered))
      throw new Error("pq_resilience_kem_round_trip_failed");
    const aead = sealResilienceProbe(
      deriveResilienceProbeKey(encapsulated.sharedKey)
    );
    const plaintext = openResilienceProbe(
      deriveResilienceProbeKey(recovered),
      aead
    );
    if (plaintext.toString("utf8") !== "athena-pq-resilience-secret")
      throw new Error("pq_resilience_aead_round_trip_failed");
    latencies.push(performance.now() - iterationStartedAt);
  }
  return {
    success: true,
    iterations,
    durationMs: performance.now() - startedAt,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    checks: {
      runtimeProvider: true,
      hybridSignature: true,
      mlKEM768: true,
      hkdfSha256: true,
      aes256Gcm: true,
    },
  };
}

function faultScenario() {
  const startedAt = performance.now();
  const fixture = hybridFixture();
  const checks = [];

  const tamperedData = Buffer.from(fixture.data);
  tamperedData[0] ^= 0xff;
  expectRejected(
    "tampered_payload",
    () => !verifyHybrid({ ...fixture, data: tamperedData }).valid,
    checks
  );

  const downgraded = structuredClone(fixture.envelope);
  downgraded.policy = {
    threshold: 1,
    classicalRequired: true,
    pqRequired: false,
  };
  downgraded.signatures = downgraded.signatures.filter(
    (signature) => signature.family === "classical"
  );
  expectRejected(
    "policy_downgrade",
    () => !verifyHybrid({ ...fixture, envelope: downgraded }).valid,
    checks
  );

  const corruptedSignature = structuredClone(fixture.envelope);
  const pqSignature = corruptedSignature.signatures.find(
    (signature) => signature.family === "post-quantum"
  );
  pqSignature.signature = Buffer.alloc(3309, 0xa5).toString("base64");
  expectRejected(
    "corrupted_pq_signature",
    () => !verifyHybrid({ ...fixture, envelope: corruptedSignature }).valid,
    checks
  );

  const malformedKey = structuredClone(fixture.envelope);
  const malformedTrust = structuredClone(fixture.trustedKeys);
  const malformedSignature = malformedKey.signatures.find(
    (signature) => signature.family === "post-quantum"
  );
  malformedSignature.publicKey = "bm90LWEtcHVibGljLWtleQ==";
  malformedTrust.find(
    (key) => key.keyId === malformedSignature.keyId
  ).publicKey = malformedSignature.publicKey;
  expectRejected(
    "malformed_pq_public_key",
    () =>
      !verifyHybrid({
        ...fixture,
        envelope: malformedKey,
        trustedKeys: malformedTrust,
      }).valid,
    checks
  );

  expectRejected(
    "missing_pq_trust_anchor",
    () =>
      !verifyHybrid({
        ...fixture,
        trustedKeys: fixture.trustedKeys.filter(
          (key) => key.keyId !== "resilience-pq"
        ),
      }).valid,
    checks
  );

  expectRejected(
    "expired_pq_key_id",
    () =>
      !verifyHybrid({
        ...fixture,
        trustedKeys: fixture.trustedKeys.map((key) =>
          key.keyId === "resilience-pq"
            ? { ...key, expiresAt: new Date(Date.now() - 1_000).toISOString() }
            : key
        ),
      }).valid,
    checks
  );

  const duplicateSigner = structuredClone(fixture.envelope);
  duplicateSigner.signatures.push(
    structuredClone(duplicateSigner.signatures[1])
  );
  duplicateSigner.policy.threshold = 3;
  expectRejected(
    "duplicate_signer",
    () => !verifyHybrid({ ...fixture, envelope: duplicateSigner }).valid,
    checks
  );

  const unknownSuite = structuredClone(fixture.envelope);
  unknownSuite.signatures[1].suiteId = "release-evidence-unknown-v99";
  expectRejected(
    "unknown_pq_suite",
    () => !verifyHybrid({ ...fixture, envelope: unknownSuite }).valid,
    checks
  );

  const parameterMismatch = structuredClone(fixture.envelope);
  parameterMismatch.signatures[1].parameterSet = "ML-DSA-87";
  expectRejected(
    "pq_parameter_set_mismatch",
    () => !verifyHybrid({ ...fixture, envelope: parameterMismatch }).valid,
    checks
  );

  const kem = crypto.generateKeyPairSync("ml-kem-768");
  const wrongKem = crypto.generateKeyPairSync("ml-kem-768");
  const encapsulated = crypto.encapsulate(kem.publicKey);
  const aead = sealResilienceProbe(
    deriveResilienceProbeKey(encapsulated.sharedKey)
  );
  const corruptedCiphertext = Buffer.from(encapsulated.ciphertext);
  corruptedCiphertext[Math.floor(corruptedCiphertext.length / 2)] ^= 0x01;
  expectRejected(
    "corrupted_kem_ciphertext",
    () => {
      const wrongSecret = crypto.decapsulate(
        kem.privateKey,
        corruptedCiphertext
      );
      openResilienceProbe(deriveResilienceProbeKey(wrongSecret), aead);
      return false;
    },
    checks
  );
  expectRejected(
    "wrong_kem_private_key",
    () => {
      const wrongSecret = crypto.decapsulate(
        wrongKem.privateKey,
        encapsulated.ciphertext
      );
      openResilienceProbe(deriveResilienceProbeKey(wrongSecret), aead);
      return false;
    },
    checks
  );
  expectRejected(
    "truncated_kem_ciphertext",
    () => {
      crypto.decapsulate(
        kem.privateKey,
        encapsulated.ciphertext.subarray(0, 64)
      );
      return false;
    },
    checks
  );
  expectRejected(
    "wrong_aead_epoch_context",
    () => {
      openResilienceProbe(
        deriveResilienceProbeKey(encapsulated.sharedKey),
        aead,
        Buffer.from("vault-device:resilience:epoch:2")
      );
      return false;
    },
    checks
  );

  const failed = checks.filter((check) => !check.rejected);
  return {
    success: failed.length === 0,
    durationMs: performance.now() - startedAt,
    expectedRejections: checks.length,
    rejected: checks.length - failed.length,
    checks,
    findings: failed.map((check) => `fault_not_rejected:${check.name}`),
  };
}

function runWorker(workerData, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "pqResilienceWorker.js"), {
      workerData,
      resourceLimits: {
        maxOldGenerationSizeMb: 256,
        maxYoungGenerationSizeMb: 32,
      },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("pq_resilience_worker_timeout"));
    }, timeoutMs);
    timer.unref?.();
    worker.once("message", (result) => {
      clearTimeout(timer);
      if (result?.success) resolve(result);
      else reject(new Error(result?.error || "pq_resilience_worker_failed"));
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`pq_resilience_worker_exit:${code}`));
    });
  });
}

async function extremeScenario({
  iterations,
  concurrency,
  payloadBytes,
  thresholds,
}) {
  concurrency = Math.min(concurrency, iterations);
  const startedAt = performance.now();
  const rssBefore = process.memoryUsage().rss;
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  const baseIterations = Math.floor(iterations / concurrency);
  const remainder = iterations % concurrency;
  const workers = await Promise.all(
    Array.from({ length: concurrency }, (_, workerIndex) =>
      runWorker({
        workerIndex,
        payloadBytes,
        iterations: baseIterations + (workerIndex < remainder ? 1 : 0),
      })
    )
  );
  eventLoop.disable();

  const durationMs = performance.now() - startedAt;
  const rssDeltaMiB =
    Math.max(process.memoryUsage().rss - rssBefore, 0) / 2 ** 20;
  const p95Ms = Math.max(...workers.map((worker) => worker.p95Ms));
  const eventLoopP99Ms = Number(eventLoop.percentile(99)) / 1_000_000;
  const operationsPerSecond = iterations / Math.max(durationMs / 1_000, 0.001);
  const largePayload = Buffer.alloc(
    Math.min(MAX_PAYLOAD_BYTES, Math.max(payloadBytes, 2 * 1024 * 1024)),
    0x5a
  );
  const largePayloadKeys = crypto.generateKeyPairSync("ml-dsa-65");
  const largePayloadStartedAt = performance.now();
  const largePayloadSignature = crypto.sign(
    null,
    largePayload,
    largePayloadKeys.privateKey
  );
  const largePayloadValid = crypto.verify(
    null,
    largePayload,
    largePayloadKeys.publicKey,
    largePayloadSignature
  );
  const largePayloadDurationMs = performance.now() - largePayloadStartedAt;
  const findings = [];
  if (p95Ms > thresholds.p95Ms)
    findings.push(`p95_budget_exceeded:${p95Ms.toFixed(3)}`);
  if (eventLoopP99Ms > thresholds.eventLoopP99Ms)
    findings.push(
      `event_loop_p99_budget_exceeded:${eventLoopP99Ms.toFixed(3)}`
    );
  if (rssDeltaMiB > thresholds.rssDeltaMiB)
    findings.push(`rss_budget_exceeded:${rssDeltaMiB.toFixed(3)}`);
  if (operationsPerSecond < thresholds.minimumOperationsPerSecond)
    findings.push(
      `throughput_budget_not_met:${operationsPerSecond.toFixed(3)}`
    );
  if (!largePayloadValid) findings.push("large_payload_signature_invalid");

  return {
    success: findings.length === 0,
    iterations,
    concurrency,
    payloadBytes,
    durationMs,
    operationsPerSecond,
    p95Ms,
    eventLoopP99Ms,
    rssDeltaMiB,
    largePayloadBytes: largePayload.length,
    largePayloadDurationMs,
    workerFailures: 0,
    findings,
    thresholds,
  };
}

async function runPQResilienceValidation(options = {}) {
  const profile = String(options.profile || "all").toLowerCase();
  if (!["all", "normal", "fault", "extreme"].includes(profile))
    throw new Error("pq_resilience_profile_invalid");
  const ci = options.ci === true;
  const iterations = boundedInteger(
    options.iterations,
    ci ? 120 : 240,
    1,
    MAX_ITERATIONS,
    "iterations"
  );
  const concurrency = boundedInteger(
    options.concurrency,
    Math.min(ci ? 4 : 6, Math.max(os.availableParallelism?.() || 2, 1)),
    1,
    MAX_CONCURRENCY,
    "concurrency"
  );
  const payloadBytes = boundedInteger(
    options.payloadBytes,
    ci ? 64 * 1024 : 256 * 1024,
    4,
    MAX_PAYLOAD_BYTES,
    "payload_bytes"
  );
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    ...(options.thresholds || {}),
  };
  const startedAt = performance.now();
  const scenarios = {};
  if (profile === "all" || profile === "normal")
    scenarios.normal = normalScenario({
      iterations: Math.min(iterations, ci ? 30 : 50),
    });
  if (profile === "all" || profile === "fault")
    scenarios.fault = faultScenario();
  if (profile === "all" || profile === "extreme")
    scenarios.extreme = await extremeScenario({
      iterations,
      concurrency,
      payloadBytes,
      thresholds,
    });
  const findings = Object.entries(scenarios).flatMap(([scenario, result]) =>
    result.success
      ? []
      : (result.findings || ["scenario_failed"]).map(
          (finding) => `${scenario}:${finding}`
        )
  );
  return {
    format: RESILIENCE_FORMAT,
    success: findings.length === 0,
    runId: crypto.randomUUID(),
    generatedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      openssl: process.versions.openssl,
      platform: process.platform,
      architecture: process.arch,
    },
    profile,
    durationMs: performance.now() - startedAt,
    scenarios,
    findings,
    security: {
      ephemeralKeysOnly: true,
      keyMaterialIncluded: false,
      automaticRemediation: false,
      algorithmDowngradeAllowed: false,
    },
  };
}

module.exports = {
  DEFAULT_THRESHOLDS,
  RESILIENCE_FORMAT,
  faultScenario,
  normalScenario,
  runPQResilienceValidation,
};
