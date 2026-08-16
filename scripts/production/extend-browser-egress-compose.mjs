#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const currentFile = argument("--current");
const candidateFile = argument("--candidate");
const outputFile = argument("--output");
if (!currentFile || !candidateFile || !outputFile) {
  throw new Error(
    "usage: extend-browser-egress-compose.mjs --current current.json --candidate candidate.json --output next.json"
  );
}

const current = JSON.parse(fs.readFileSync(currentFile, "utf8"));
const candidate = JSON.parse(fs.readFileSync(candidateFile, "utf8"));
const serviceName = "anything-llm-browser-egress";
const service = candidate.services?.[serviceName];
if (!service) throw new Error("browser_egress_candidate_service_missing");

current.services ||= {};
current.services[serviceName] = service;
if (current.services["anything-llm-operations-plane"]) {
  const operations = current.services["anything-llm-operations-plane"];
  operations.mem_limit = "384m";
  operations.environment ||= {};
  operations.environment.ATHENA_OPERATIONS_MODULE_POLL_MS = "60000";
  operations.environment.ATHENA_OPERATIONS_MODULE_TIMEOUT_MS = "3000";
  operations.environment.ATHENA_OPERATIONS_INFRA_POLL_MS = "60000";
}

const egressUrl = "https://anything-llm-browser-egress:3033";
for (const existing of Object.values(current.services)) {
  const environment = existing?.environment;
  if (!environment || typeof environment !== "object") continue;
  if (environment.ATHENA_RUNTIME_ROLE) {
    environment.ATHENA_BROWSER_EGRESS_URL = egressUrl;
  }
  if (typeof environment.ATHENA_MODULE_RUNTIME_ENDPOINTS === "string") {
    const endpoints = JSON.parse(environment.ATHENA_MODULE_RUNTIME_ENDPOINTS);
    endpoints["browser-egress"] = egressUrl;
    environment.ATHENA_MODULE_RUNTIME_ENDPOINTS = JSON.stringify(endpoints);
  }
}

const serialized = `${JSON.stringify(current, null, 2)}\n`;
fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, serialized, { mode: 0o640, flag: "wx" });
console.log(
  JSON.stringify({
    success: true,
    services: Object.keys(current.services).length,
    browserEgressAdded: true,
  })
);
