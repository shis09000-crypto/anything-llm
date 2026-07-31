#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REPORT_VERSION = "athena.preproduction-host-admission:v1";
const MIN_CPU_COUNT = 4;
const MIN_MEMORY_BYTES = 12 * 1024 ** 3;
const MIN_DISK_BYTES = 40 * 1024 ** 3;
const PRODUCTION_CONTAINER_NAMES = new Set(["anythingllm", "anythingllm-v2"]);
const PRODUCTION_COMPOSE_PROJECTS = new Set(["anythingllm", "anythingllm-v2"]);

function gibibytes(value) {
  return Math.round((Number(value || 0) / 1024 ** 3) * 10) / 10;
}

function existingAncestor(target) {
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function command(runner, command, args) {
  try {
    return String(runner(command, args) || "").trim();
  } catch {
    return null;
  }
}

function collectHostSnapshot({
  stateDir,
  runner = (binary, args) =>
    execFileSync(binary, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
} = {}) {
  const dockerVersion = command(runner, "docker", [
    "version",
    "--format",
    "{{.Server.Version}}",
  ]);
  const composeVersion = command(runner, "docker", [
    "compose",
    "version",
    "--short",
  ]);
  const buildxVersion = command(runner, "docker", ["buildx", "version"]);
  const dockerInfo = command(runner, "docker", [
    "info",
    "--format",
    "{{json .}}",
  ]);
  let info = {};
  try {
    info = dockerInfo ? JSON.parse(dockerInfo) : {};
  } catch {
    info = {};
  }
  const running = command(runner, "docker", [
    "ps",
    "--format",
    '{{.Names}}\t{{.Label "com.docker.compose.project"}}',
  ]);
  const runningContainers = String(running || "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, composeProject = ""] = line.split("\t");
      return { name, composeProject };
    });

  let diskFreeBytes = 0;
  try {
    const stats = fs.statfsSync(existingAncestor(stateDir));
    diskFreeBytes = Number(stats.bavail) * Number(stats.bsize);
  } catch {
    diskFreeBytes = 0;
  }

  return {
    docker: {
      available: dockerVersion !== null,
      engineReady: Boolean(dockerVersion && dockerInfo),
      composeV2: Boolean(composeVersion),
      buildx: Boolean(buildxVersion),
      architecture: String(info.Architecture || "").toLowerCase(),
      cpuCount: Number(info.NCPU || 0),
      memoryBytes: Number(info.MemTotal || 0),
      runningContainers,
    },
    diskFreeBytes,
  };
}

function safePublicOrigin(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") return null;
    if (url.port && url.port !== "443") return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    if (
      ["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
      url.hostname.endsWith(".invalid")
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

function unsafeStateDirectory(stateDir, repoRoot) {
  const target = path.resolve(stateDir);
  const repository = path.resolve(repoRoot);
  const productionData = path.resolve("/data/anythingllm");
  return (
    target === path.parse(target).root ||
    target === "/data" ||
    target === productionData ||
    target.startsWith(`${productionData}${path.sep}`) ||
    target === repository ||
    target.startsWith(`${repository}${path.sep}`)
  );
}

function evaluatePreproductionHost({
  env = process.env,
  snapshot,
  repoRoot,
  stateDir,
} = {}) {
  const findings = [];
  const environment = String(env.APP_ENV || "preproduction").toLowerCase();
  const publicOrigin = safePublicOrigin(env.ATHENA_PREPROD_PUBLIC_URL);
  const docker = snapshot?.docker || {};
  const matchedProductionContainers = (docker.runningContainers || []).filter(
    ({ name, composeProject }) =>
      PRODUCTION_CONTAINER_NAMES.has(name) ||
      PRODUCTION_COMPOSE_PROJECTS.has(composeProject)
  );

  if (env.ATHENA_PREPROD_CONFIRM !== "athena-preproduction")
    findings.push("preproduction_confirmation_missing");
  if (environment !== "preproduction")
    findings.push("preproduction_environment_required");
  if (!publicOrigin) findings.push("dedicated_https_public_url_required");
  if (unsafeStateDirectory(stateDir, repoRoot))
    findings.push("preproduction_state_directory_unsafe");
  if (!docker.available) findings.push("docker_cli_unavailable");
  if (!docker.engineReady) findings.push("docker_engine_unavailable");
  if (!docker.composeV2) findings.push("docker_compose_v2_unavailable");
  if (!docker.buildx) findings.push("docker_buildx_unavailable");
  if (!["amd64", "x86_64"].includes(String(docker.architecture || "")))
    findings.push("amd64_docker_engine_required");
  if (Number(docker.cpuCount || 0) < MIN_CPU_COUNT)
    findings.push("preproduction_cpu_capacity_insufficient");
  if (Number(docker.memoryBytes || 0) < MIN_MEMORY_BYTES)
    findings.push("preproduction_memory_capacity_insufficient");
  if (Number(snapshot?.diskFreeBytes || 0) < MIN_DISK_BYTES)
    findings.push("preproduction_disk_capacity_insufficient");
  if (matchedProductionContainers.length)
    findings.push("production_runtime_detected_on_preproduction_host");

  return {
    version: REPORT_VERSION,
    ready: findings.length === 0,
    environment,
    stateDirectory: path.resolve(stateDir),
    publicOrigin,
    publicHostname: publicOrigin ? new URL(publicOrigin).hostname : null,
    requirements: {
      cpuCount: MIN_CPU_COUNT,
      memoryGiB: gibibytes(MIN_MEMORY_BYTES),
      diskGiB: gibibytes(MIN_DISK_BYTES),
      architecture: "amd64",
      dedicatedHost: true,
    },
    observed: {
      cpuCount: Number(docker.cpuCount || 0),
      memoryGiB: gibibytes(docker.memoryBytes),
      diskFreeGiB: gibibytes(snapshot?.diskFreeBytes),
      architecture: docker.architecture || null,
      dockerEngineReady: Boolean(docker.engineReady),
      composeV2: Boolean(docker.composeV2),
      buildx: Boolean(docker.buildx),
      productionRuntimeMatches: matchedProductionContainers.map(
        ({ name, composeProject }) => ({ name, composeProject })
      ),
    },
    findings,
  };
}

function main() {
  const repoRoot = path.resolve(__dirname, "../..");
  const stateDir =
    process.env.ATHENA_PREPROD_STATE_DIR || "/data/athena-preproduction";
  const snapshot = collectHostSnapshot({ stateDir });
  const result = evaluatePreproductionHost({
    env: process.env,
    snapshot,
    repoRoot,
    stateDir,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 2;
}

if (require.main === module) main();

module.exports = {
  MIN_CPU_COUNT,
  MIN_DISK_BYTES,
  MIN_MEMORY_BYTES,
  REPORT_VERSION,
  collectHostSnapshot,
  evaluatePreproductionHost,
  safePublicOrigin,
  unsafeStateDirectory,
};
