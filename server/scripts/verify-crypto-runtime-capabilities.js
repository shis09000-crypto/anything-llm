#!/usr/bin/env node
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const {
  majorVersion,
  probeClassicalBaseline,
  probePostQuantum,
  requiredPostQuantumFindings,
} = require("../utils/security/cryptoRuntimeCapabilities");

function systemOpenSSLProviders() {
  const command = spawnSync("openssl", ["list", "-providers"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (command.error || command.status !== 0) return [];
  return String(command.stdout || "")
    .split("\n")
    .filter((line) => /^\s{2}\S/.test(line))
    .map((line) => line.trim());
}

const classicalFindings = probeClassicalBaseline();
const postQuantum = probePostQuantum();
const requireNode24PQ =
  process.env.ATHENA_REQUIRE_NODE24_PQ_PROBE === "true" ||
  process.argv.includes("--require-node24-pq");
const supportedCompatibilityVersion = [18, 22, 24].includes(majorVersion());
const capabilities = {
  ml_kem_768: postQuantum.mlKEM768,
  ml_dsa_65: postQuantum.mlDSA65,
  encapsulation_api: postQuantum.encapsulationApi,
  classical_provider_baseline: classicalFindings.length === 0,
};
const findings = [
  ...classicalFindings,
  ...(!supportedCompatibilityVersion
    ? [`compatibility_version_unverified:${majorVersion()}`]
    : []),
  ...requiredPostQuantumFindings({
    required: requireNode24PQ,
    runtimeMajor: majorVersion(),
    capabilities,
  }),
];

console.log(
  JSON.stringify(
    {
      success: findings.length === 0,
      node: process.version,
      compatibilityPromise: ["18", "22", "24"],
      nodeOpenSSL: process.versions.openssl,
      fipsMode: crypto.getFips(),
      nodeDefaultProviderBaseline: classicalFindings.length === 0,
      systemOpenSSLProviders: systemOpenSSLProviders(),
      postQuantum,
      postQuantumRequired: requireNode24PQ,
      findings,
    },
    null,
    2
  )
);
if (findings.length) process.exitCode = 1;
