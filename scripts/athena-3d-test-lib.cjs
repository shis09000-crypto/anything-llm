const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const { performance } = require("perf_hooks");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_REPORT_DIR = path.join(ROOT, "reports", "athena-3d-center");
const EVIDENCE_SCHEMAS = [
  "athena-character-responses-v1.schema.json",
  "athena-character-responses-v2.schema.json",
  "athena-character-conversations-v2.schema.json",
  "athena-character-performance-pack-v1.schema.json",
  "athena-character-performance-plan-v1.schema.json",
  "athena-3d-center-frame-v1.schema.json",
  "athena-3d-center-incremental-responses-v1.schema.json",
  "athena-3d-session-memory-v1.schema.json",
  "athena-3d-center-long-term-character-memory-v1.schema.json",
  "athena-3d-center-character-memory-v2.schema.json",
];

function fileSha256(location) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(location))
    .digest("hex");
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function evidence() {
  const schemaRoot = path.join(ROOT, "docs", "schemas");
  const schemaSha256 = Object.fromEntries(
    EVIDENCE_SCHEMAS.map((name) => [
      name,
      fileSha256(path.join(schemaRoot, name)),
    ])
  );
  const manifestLocation = path.join(
    ROOT,
    "docs/examples/character-responses/v2/06-capability-manifest.json"
  );
  const packLocation = path.join(
    ROOT,
    "server/character-performance-packs/mock-anatomy-v1.json"
  );
  const manifest = JSON.parse(fs.readFileSync(manifestLocation, "utf8"));
  const pack = JSON.parse(fs.readFileSync(packLocation, "utf8"));
  let core = null;
  try {
    core = require(
      path.join(
        ROOT,
        "server/utils/chats/threeDSessionMemory/characterCoreRegistry.js"
      )
    ).CORES["athena.test.cold_tsundere"];
  } catch {
    core = null;
  }
  return {
    git_commit: gitCommit(),
    random_seed: process.env.ATHENA_3D_TEST_RANDOM_SEED || null,
    model_contract: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      response_format: { type: "json_object" },
      selection_retries: 0,
    },
    digests: {
      schemas: schemaSha256,
      character_core: core
        ? { id: core.id, version: core.version, sha256: core.sha256 }
        : null,
      character_manifest: {
        id: manifest.id,
        version: manifest.version,
        sha256: manifest.integrity.sha256,
      },
      performance_pack: {
        id: pack.id,
        version: pack.version,
        sha256: pack.integrity.sha256,
      },
    },
  };
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * ordered.length) - 1)
  );
  return Number(ordered[index].toFixed(3));
}

function metric(values, thresholdMs = null) {
  const result = {
    samples: values.length,
    min_ms: values.length ? Number(Math.min(...values).toFixed(3)) : null,
    p50_ms: percentile(values, 50),
    p95_ms: percentile(values, 95),
    p99_ms: percentile(values, 99),
    max_ms: values.length ? Number(Math.max(...values).toFixed(3)) : null,
    threshold_ms: thresholdMs,
  };
  result.passed = thresholdMs == null || result.p95_ms <= thresholdMs;
  return result;
}

async function measure(iterations, operation, { warmup = 25 } = {}) {
  for (let index = 0; index < warmup; index += 1) await operation(index, true);
  const values = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    await operation(index, false);
    values.push(performance.now() - startedAt);
  }
  return values;
}

function environment() {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model || null,
    cpu_count: os.cpus().length,
    memory_bytes: os.totalmem(),
    ci: String(process.env.CI || "") === "true",
  };
}

function reportPath(name) {
  const directory = process.env.ATHENA_3D_TEST_REPORT_DIR || DEFAULT_REPORT_DIR;
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, `${name}.json`);
}

function writeReport(name, payload) {
  const destination = reportPath(name);
  const report = {
    object: "athena.3d_center.test_report",
    protocol_version: "1.0",
    generated_at: Date.now(),
    environment: environment(),
    evidence: evidence(),
    ...payload,
  };
  fs.writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
  return { destination, report };
}

function requiredEnvironment(names) {
  const missing = names.filter(
    (name) => !String(process.env[name] || "").trim()
  );
  if (!missing.length) return;
  const error = new Error(
    `Required test environment is missing: ${missing.join(", ")}`
  );
  error.code = "ATHENA_3D_TEST_INFRASTRUCTURE_MISSING";
  error.missing = missing;
  throw error;
}

function exactWarnings(warnings = [], allowed = []) {
  const allowedSet = new Set(allowed);
  return warnings.every((warning) => allowedSet.has(warning.code));
}

module.exports = {
  ROOT,
  exactWarnings,
  measure,
  metric,
  percentile,
  requiredEnvironment,
  writeReport,
};
