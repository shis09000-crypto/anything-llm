#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  DeleteObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");
const {
  requestInternalService,
} = require("../utils/microModules/internalClient");
const { loadManifests } = require("../utils/modulePlatform/manifestRegistry");
const { evaluateCutover } = require("./verify-micro-module-cutover");
const { DataAccessCenter } = require("../utils/dataAccess");

const EXPECTED_PROMETHEUS_MODULES = Object.freeze([
  "athena-api",
  "edge-web",
  "background-worker",
  "sync-v2",
  "reader-worker",
  "scheduler",
  "operations-plane",
  "chat-runtime",
  "agent-runtime",
  "model-gateway",
  "tool-runtime",
  "crypto-market",
  "crypto-account-access",
  "crypto-forecast",
  "key-custody",
  "collector",
]);

function argument(name, fallback = null) {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function baseOperationsUrl() {
  return String(process.env.ATHENA_OPERATIONS_INTERNAL_URL || "")
    .trim()
    .replace(/\/$/, "");
}

async function operations(pathname, method = "GET") {
  return requestInternalService({
    callerRole: "api",
    url: `${baseOperationsUrl()}${pathname}`,
    method,
    env: process.env,
    timeoutMs: 10_000,
  });
}

async function waitForOperations(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await operations("/internal/v1/operations/health");
      const summary = last.moduleHealth?.summary || {};
      const heartbeats = last.moduleHeartbeatCoverage || {};
      if (
        last.ready === true &&
        summary.total === 20 &&
        summary.healthy === 20 &&
        summary.degraded === 0 &&
        summary.unmonitored === 0 &&
        heartbeats.expected === 20 &&
        heartbeats.fresh === 20 &&
        (heartbeats.missing || []).length === 0
      )
        return last;
    } catch (error) {
      last = { error: error.code || error.message };
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  const error = new Error("preproduction_operations_coverage_timeout");
  error.code = "PREPRODUCTION_OPERATIONS_COVERAGE_TIMEOUT";
  error.last = last;
  throw error;
}

async function prometheusCoverage(timeoutMs) {
  const endpoint = String(
    process.env.ATHENA_PROMETHEUS_URL || "http://prometheus:9090"
  ).replace(/\/$/, "");
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    const response = await fetch(`${endpoint}/api/v1/targets`);
    if (response.ok) {
      const payload = await response.json();
      last = payload.data?.activeTargets || [];
      const modules = new Map(
        last
          .filter((target) => target.labels?.module_id)
          .map((target) => [target.labels.module_id, target.health])
      );
      const missing = EXPECTED_PROMETHEUS_MODULES.filter(
        (moduleId) => modules.get(moduleId) !== "up"
      );
      if (!missing.length)
        return {
          expected: EXPECTED_PROMETHEUS_MODULES.length,
          up: EXPECTED_PROMETHEUS_MODULES.length,
          missing: [],
          modules: Object.fromEntries(modules),
        };
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return {
    expected: EXPECTED_PROMETHEUS_MODULES.length,
    up: last.filter(
      (target) =>
        EXPECTED_PROMETHEUS_MODULES.includes(target.labels?.module_id) &&
        target.health === "up"
    ).length,
    missing: EXPECTED_PROMETHEUS_MODULES.filter(
      (moduleId) =>
        !last.some(
          (target) =>
            target.labels?.module_id === moduleId && target.health === "up"
        )
    ),
  };
}

async function objectStoreProbe() {
  const bucket = process.env.ATHENA_S3_BUCKET;
  const client = new S3Client({
    endpoint: process.env.ATHENA_S3_ENDPOINT,
    region: process.env.ATHENA_S3_REGION || "us-east-1",
    forcePathStyle: process.env.ATHENA_S3_FORCE_PATH_STYLE === "true",
  });
  const key = `athena/preproduction-evidence/${crypto.randomUUID()}.probe`;
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: Buffer.from("athena-preproduction-object-store-probe"),
      })
    );
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return { ready: true, provider: "s3", writeReadDeleteProbe: true };
  } finally {
    client.destroy();
  }
}

function moduleCounts(moduleHealth) {
  const modules = moduleHealth.modules || [];
  return {
    total: modules.length,
    healthy: modules.filter((module) => module.status === "healthy").length,
    degraded: modules.filter((module) => module.status === "degraded").length,
    unmonitored: modules.filter((module) => module.status === "unmonitored")
      .length,
    unknown: modules.filter((module) => module.status === "unknown").length,
  };
}

async function main() {
  if (process.env.APP_ENV !== "preproduction")
    throw new Error("preproduction_environment_required");
  if (process.env.ATHENA_RUNTIME_TOPOLOGY !== "distributed")
    throw new Error("distributed_topology_required");
  const timeoutMs = Math.max(30_000, Number(argument("timeout-ms", "180000")));
  const health = await waitForOperations(timeoutMs);
  const [moduleHealth, prometheus, database, objectStore] = await Promise.all([
    operations("/internal/v1/operations/module-health").then(
      (result) => result.moduleHealth
    ),
    prometheusCoverage(timeoutMs),
    DataAccessCenter.runtimeLifecycle.databaseReadiness(),
    objectStoreProbe(),
  ]);
  const topology = evaluateCutover({
    env: process.env,
    phase: "foundation",
    strict: false,
  });
  const counts = moduleCounts(moduleHealth);
  const ready =
    topology.ready &&
    counts.total === 20 &&
    counts.healthy === 20 &&
    counts.degraded === 0 &&
    counts.unmonitored === 0 &&
    counts.unknown === 0 &&
    health.moduleHeartbeatCoverage?.fresh === 20 &&
    prometheus.up === prometheus.expected &&
    database?.ready !== false &&
    objectStore.ready;
  const evidence = {
    version: "athena.preproduction-topology-evidence:v1",
    generatedAt: new Date().toISOString(),
    environment: "preproduction",
    ready,
    authoritativePaths: {
      database: topology.topology.database,
      broadcast: topology.topology.broadcast,
      contentStore: topology.topology.contentStore,
      serviceMtlsRequired: topology.topology.serviceMtlsRequired,
      durableReaderQueue: topology.topology.durableReaderQueue,
    },
    manifests: {
      count: loadManifests().length,
      fingerprints: topology.modules.fingerprints,
    },
    operations: {
      status: health.status,
      ready: health.ready,
      counts,
      coverage: health.coverage,
      heartbeats: {
        expected: health.moduleHeartbeatCoverage?.expected || 0,
        fresh: health.moduleHeartbeatCoverage?.fresh || 0,
        stale: health.moduleHeartbeatCoverage?.stale || 0,
        missing: health.moduleHeartbeatCoverage?.missing || [],
      },
      shadowAgents: {
        status: health.shadowAgents?.status || "unknown",
        enabled: Boolean(health.shadowAgents?.enabled),
      },
    },
    prometheus,
    database: {
      ready: database?.ready !== false,
      provider: process.env.ATHENA_DATABASE_PROVIDER,
    },
    objectStore,
    findings: [
      ...topology.findings,
      ...(counts.unknown ? ["operations_unknown_nonzero"] : []),
      ...(counts.unmonitored ? ["operations_unmonitored_nonzero"] : []),
      ...(counts.degraded ? ["operations_degraded_nonzero"] : []),
      ...prometheus.missing.map(
        (moduleId) => `prometheus_target_missing:${moduleId}`
      ),
    ],
  };
  const output = argument("output");
  if (output) {
    const target = path.resolve(output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  console.log(JSON.stringify(evidence, null, 2));
  if (!ready) process.exitCode = 2;
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ready: false,
        error: error.code || error.message,
        last: error.last || null,
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
