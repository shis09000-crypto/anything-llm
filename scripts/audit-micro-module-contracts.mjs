#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const repoRoot = process.cwd();
const require = createRequire(import.meta.url);
const {
  loadManifests,
} = require("../server/utils/modulePlatform/manifestRegistry");

const ignored = new Set([
  ".git",
  "node_modules",
  "storage",
  "public",
  "dist",
  "build",
  ".anythingllm-build",
]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function walk(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath, files);
    else files.push(toPosix(path.relative(repoRoot, fullPath)));
  }
  return files;
}

function sourceMatches(files, sourcePath) {
  const normalized = toPosix(sourcePath);
  return files.some(
    (file) =>
      file === normalized ||
      file.startsWith(
        normalized.endsWith("/") ? normalized : `${normalized}/`
      ) ||
      file.startsWith(normalized)
  );
}

function detectCycles(manifests) {
  const ids = new Set(manifests.map((manifest) => manifest.id));
  const graph = new Map(
    manifests.map((manifest) => [
      manifest.id,
      manifest.dependsOn.filter((dependency) => ids.has(dependency)),
    ])
  );
  const visiting = new Set();
  const visited = new Set();
  const cycles = [];
  function visit(id, stack = []) {
    if (visiting.has(id)) {
      const offset = stack.indexOf(id);
      cycles.push([...stack.slice(offset), id]);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id) || [])
      visit(dependency, [...stack, id]);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of graph.keys()) visit(id);
  return cycles;
}

const manifests = loadManifests();
const files = walk(repoRoot);
const findings = [];
const rpcProviders = new Map();
const publicRoutes = new Map();
const schemaOwners = new Map();
const serviceIdentities = new Map();
const ids = new Set(manifests.map((manifest) => manifest.id));
const reservedCallers = new Set(["public-client"]);
const targetScopedStandardCapabilities = new Set([
  "module.describe",
  "module.self-test",
  "module.lifecycle.query",
  "module.drain",
  "module.quiesce",
  "module.resume",
]);

for (const manifest of manifests) {
  for (const sourcePath of manifest.sourcePaths)
    if (!sourceMatches(files, sourcePath))
      findings.push(
        `source_path_unmatched:${manifest.id}:${toPosix(sourcePath)}`
      );
  for (const capability of manifest.rpc.provides) {
    const providers = rpcProviders.get(capability) || [];
    if (providers.length && !targetScopedStandardCapabilities.has(capability))
      findings.push(
        `rpc_provider_duplicate:${capability}:${providers[0]}:${manifest.id}`
      );
    rpcProviders.set(capability, [...providers, manifest.id]);
  }
  for (const route of manifest.routes.public) {
    if (publicRoutes.has(route))
      findings.push(
        `public_route_duplicate:${route}:${publicRoutes.get(route)}:${manifest.id}`
      );
    else publicRoutes.set(route, manifest.id);
  }
  for (const schema of manifest.data.schemas) {
    if (schemaOwners.has(schema))
      findings.push(
        `schema_owner_duplicate:${schema}:${schemaOwners.get(schema)}:${manifest.id}`
      );
    else schemaOwners.set(schema, manifest.id);
  }
  const identity = manifest.security.serviceIdentity;
  if (serviceIdentities.has(identity))
    findings.push(
      `service_identity_duplicate:${identity}:${serviceIdentities.get(identity)}:${manifest.id}`
    );
  else serviceIdentities.set(identity, manifest.id);
  for (const caller of manifest.security.allowedCallers)
    if (!ids.has(caller) && !reservedCallers.has(caller))
      findings.push(`allowed_caller_unknown:${manifest.id}:${caller}`);
  const aicpRules = manifest.coordination?.aicpPolicy?.links || [];
  const seenAicpRules = new Set();
  for (const rule of aicpRules) {
    const ruleKey = `${rule.caller}:${rule.capability}`;
    if (seenAicpRules.has(ruleKey))
      findings.push(`aicp_policy_duplicate:${manifest.id}:${ruleKey}`);
    seenAicpRules.add(ruleKey);
    if (rule.caller !== "*" && !ids.has(rule.caller))
      findings.push(
        `aicp_policy_caller_unknown:${manifest.id}:${rule.caller}:${rule.capability}`
      );
    if (
      rule.capability !== "*" &&
      !manifest.rpc.provides.includes(rule.capability)
    )
      findings.push(
        `aicp_policy_capability_not_provided:${manifest.id}:${rule.capability}`
      );
  }
}

for (const manifest of manifests)
  for (const capability of manifest.rpc.consumes)
    if (!rpcProviders.has(capability))
      findings.push(`rpc_provider_missing:${manifest.id}:${capability}`);

for (const cycle of detectCycles(manifests))
  findings.push(`dependency_cycle:${cycle.join("->")}`);

console.log("Athena micro-module contract audit");
console.log(`Manifests: ${manifests.length}`);
console.log(`RPC contracts: ${rpcProviders.size}`);
console.log(`Public route owners: ${publicRoutes.size}`);
console.log(`Database schema owners: ${schemaOwners.size}`);
console.log(`Service identities: ${serviceIdentities.size}`);
if (findings.length) {
  console.log("");
  console.log("Findings:");
  findings.forEach((finding) => console.log(`- ${finding}`));
}
console.log("");
console.log(`Result: ${findings.length} error(s).`);
if (findings.length) process.exit(1);
