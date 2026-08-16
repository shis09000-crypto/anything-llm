#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const {
  requestInternalService,
} = require("../utils/microModules/internalClient");

const PROTECTED_MODULES = Object.freeze([
  "athena-api",
  "authentication",
  "chat-runtime",
  "agent-runtime",
  "sync-v2",
]);

function argument(name, fallback = null) {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function operations(pathname) {
  const base = String(process.env.ATHENA_OPERATIONS_INTERNAL_URL || "")
    .trim()
    .replace(/\/$/, "");
  return requestInternalService({
    callerRole: "api",
    callerModule: "coordination-plane",
    targetModule: "operations-plane",
    capability: "operations.catalog",
    contractVersion: "1.0",
    url: `${base}${pathname}`,
    method: "GET",
    env: process.env,
    timeoutMs: 10_000,
  });
}

async function waitForContainedFault(target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const result = await operations("/internal/v1/operations/module-health");
      const modules = result.moduleHealth?.modules || [];
      const targetState = modules.find((module) => module.id === target);
      const protectedStates = PROTECTED_MODULES.map((moduleId) =>
        modules.find((module) => module.id === moduleId)
      );
      last = {
        target: targetState?.status || "missing",
        protected: protectedStates.map((module) => ({
          id: module?.id || "missing",
          status: module?.status || "missing",
        })),
      };
      if (
        targetState?.status === "degraded" &&
        protectedStates.every((module) => module?.status === "healthy")
      )
        return last;
    } catch (error) {
      last = { error: error.code || error.message };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const error = new Error("preproduction_fault_scope_timeout");
  error.code = "PREPRODUCTION_FAULT_SCOPE_TIMEOUT";
  error.last = last;
  throw error;
}

async function main() {
  if (process.env.APP_ENV !== "preproduction")
    throw new Error("preproduction_environment_required");
  if (process.env.ATHENA_RUNTIME_TOPOLOGY !== "distributed")
    throw new Error("distributed_topology_required");
  const target = argument("target", "crypto-market");
  const timeoutMs = Math.max(15_000, Number(argument("timeout-ms", "90000")));
  const observation = await waitForContainedFault(target, timeoutMs);
  const evidence = {
    version: "athena.preproduction-fault-scope-drill:v1",
    generatedAt: new Date().toISOString(),
    environment: "preproduction",
    passed: true,
    target,
    targetDegraded: observation.target === "degraded",
    protectedModulesHealthy: observation.protected.every(
      (module) => module.status === "healthy"
    ),
    protectedModules: observation.protected,
    sensitiveValuesEmitted: false,
  };
  const output = argument("output");
  if (output) {
    const targetPath = path.resolve(output);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, `${JSON.stringify(evidence, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        version: "athena.preproduction-fault-scope-drill:v1",
        passed: false,
        error: error.code || error.message,
        last: error.last || null,
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
