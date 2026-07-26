const crypto = require("crypto");

const PQ_CAPABILITIES = Object.freeze([
  "ml_kem_768",
  "ml_dsa_65",
  "encapsulation_api",
  "classical_provider_baseline",
]);

function majorVersion() {
  return Number(String(process.versions.node).split(".")[0]) || 0;
}

function probeClassicalBaseline() {
  const findings = [];
  const ciphers = new Set(crypto.getCiphers());
  const hashes = new Set(crypto.getHashes());
  for (const cipher of ["aes-256-gcm", "chacha20-poly1305"]) {
    if (!ciphers.has(cipher)) findings.push(`missing_cipher:${cipher}`);
  }
  for (const hash of ["sha256", "sha512"]) {
    if (!hashes.has(hash)) findings.push(`missing_hash:${hash}`);
  }
  try {
    crypto.generateKeyPairSync("ed25519");
  } catch {
    findings.push("missing_key_type:ed25519");
  }
  try {
    crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  } catch {
    findings.push("missing_curve:prime256v1");
  }
  try {
    crypto.hkdfSync(
      "sha256",
      Buffer.alloc(32, 1),
      Buffer.from("athena-runtime-probe"),
      Buffer.from("hkdf"),
      32
    );
  } catch {
    findings.push("missing_kdf:hkdf-sha256");
  }
  return findings;
}

function probePostQuantum() {
  const result = {
    mlKEM768: false,
    mlDSA65: false,
    encapsulationApi:
      typeof crypto.encapsulate === "function" &&
      typeof crypto.decapsulate === "function",
    errors: [],
  };
  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ml-kem-768");
    if (!result.encapsulationApi)
      throw new Error("encapsulation_api_unavailable");
    const encapsulated = crypto.encapsulate(publicKey);
    const recovered = crypto.decapsulate(privateKey, encapsulated.ciphertext);
    result.mlKEM768 = crypto.timingSafeEqual(
      Buffer.from(encapsulated.sharedKey),
      Buffer.from(recovered)
    );
  } catch (error) {
    result.errors.push(`ml-kem-768:${error.code || error.message}`);
  }
  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ml-dsa-65");
    const payload = Buffer.from("athena-node-pq-runtime-probe");
    const signature = crypto.sign(null, payload, privateKey);
    result.mlDSA65 = crypto.verify(null, payload, publicKey, signature);
  } catch (error) {
    result.errors.push(`ml-dsa-65:${error.code || error.message}`);
  }
  return result;
}

function runtimeCapabilities() {
  const classicalFindings = probeClassicalBaseline();
  const postQuantum = probePostQuantum();
  return {
    ml_kem_768: postQuantum.mlKEM768,
    ml_dsa_65: postQuantum.mlDSA65,
    encapsulation_api: postQuantum.encapsulationApi,
    classical_provider_baseline: classicalFindings.length === 0,
    classicalFindings,
    postQuantum,
  };
}

function requiredPostQuantumFindings({
  required = false,
  runtimeMajor = majorVersion(),
  capabilities = runtimeCapabilities(),
} = {}) {
  if (!required) return [];
  if (runtimeMajor !== 24) return [`node24_required:${runtimeMajor}`];

  const missing = [
    ["ml_kem_768", capabilities.ml_kem_768],
    ["ml_dsa_65", capabilities.ml_dsa_65],
    ["encapsulation_api", capabilities.encapsulation_api],
    ["classical_provider_baseline", capabilities.classical_provider_baseline],
  ]
    .filter(([, available]) => available !== true)
    .map(([capability]) => capability);

  return missing.length
    ? [`node24_post_quantum_probe_failed:${missing.join(",")}`]
    : [];
}

function expectedCapabilities(current, env = process.env) {
  const configured = String(env.ATHENA_PQ_RUNTIME_EXPECTED_CAPABILITIES || "")
    .split(",")
    .map((value) => value.trim().toLowerCase().replace(/-/g, "_"))
    .filter(Boolean);
  const invalid = configured.filter(
    (capability) => !PQ_CAPABILITIES.includes(capability)
  );
  if (invalid.length)
    throw new Error(`pq_runtime_expected_capability_invalid:${invalid[0]}`);
  if (configured.length) {
    return Object.fromEntries(
      PQ_CAPABILITIES.map((capability) => [
        capability,
        configured.includes(capability),
      ])
    );
  }
  const requirePQ = env.ATHENA_REQUIRE_NODE24_PQ_PROBE === "true";
  return {
    ml_kem_768: requirePQ ? true : current.ml_kem_768,
    ml_dsa_65: requirePQ ? true : current.ml_dsa_65,
    encapsulation_api: requirePQ ? true : current.encapsulation_api,
    classical_provider_baseline: true,
  };
}

module.exports = {
  PQ_CAPABILITIES,
  expectedCapabilities,
  majorVersion,
  probeClassicalBaseline,
  probePostQuantum,
  requiredPostQuantumFindings,
  runtimeCapabilities,
};
