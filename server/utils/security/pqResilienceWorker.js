const crypto = require("crypto");
const { parentPort, workerData } = require("worker_threads");
const { performance } = require("perf_hooks");

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(Math.ceil(sorted.length * ratio) - 1, sorted.length - 1)
  ];
}

function run() {
  const iterations = Math.max(1, Number(workerData?.iterations) || 1);
  const payloadBytes = Math.max(1, Number(workerData?.payloadBytes) || 1);
  const payload = Buffer.alloc(
    payloadBytes,
    Number(workerData?.workerIndex) & 0xff
  );
  const classical = crypto.generateKeyPairSync("ed25519");
  const postQuantum = crypto.generateKeyPairSync("ml-dsa-65");
  const kem = crypto.generateKeyPairSync("ml-kem-768");
  const latencies = [];
  let signatureBytes = 0;
  let kemCiphertextBytes = 0;

  for (let index = 0; index < iterations; index += 1) {
    payload.writeUInt32BE(index >>> 0, 0);
    const startedAt = performance.now();
    const classicalSignature = crypto.sign(null, payload, classical.privateKey);
    const pqSignature = crypto.sign(null, payload, postQuantum.privateKey);
    if (
      !crypto.verify(null, payload, classical.publicKey, classicalSignature) ||
      !crypto.verify(null, payload, postQuantum.publicKey, pqSignature)
    )
      throw new Error("pq_resilience_signature_round_trip_failed");

    const encapsulated = crypto.encapsulate(kem.publicKey);
    const recovered = crypto.decapsulate(
      kem.privateKey,
      encapsulated.ciphertext
    );
    if (!crypto.timingSafeEqual(encapsulated.sharedKey, recovered))
      throw new Error("pq_resilience_kem_round_trip_failed");

    signatureBytes = classicalSignature.length + pqSignature.length;
    kemCiphertextBytes = encapsulated.ciphertext.length;
    latencies.push(performance.now() - startedAt);
  }

  return {
    success: true,
    iterations,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    maxMs: Math.max(...latencies),
    signatureBytes,
    kemCiphertextBytes,
  };
}

try {
  parentPort.postMessage(run());
} catch (error) {
  parentPort.postMessage({
    success: false,
    error: String(
      error?.code || error?.message || "pq_resilience_worker_failed"
    ),
  });
}
