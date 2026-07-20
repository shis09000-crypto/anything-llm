#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const policy = JSON.parse(
  fs.readFileSync(path.join(__dirname, "p0-supply-chain-policy.json"), "utf8")
);
const components = ["server", "collector", "frontend"];

function workflowSupplyChainFailures() {
  const workflowsDir = path.join(repoRoot, ".github", "workflows");
  const failures = [];
  if (!fs.existsSync(workflowsDir)) return failures;
  for (const filename of fs.readdirSync(workflowsDir)) {
    if (!/\.ya?ml$/i.test(filename)) continue;
    const source = fs.readFileSync(path.join(workflowsDir, filename), "utf8");
    for (const match of source.matchAll(
      /raw\.githubusercontent\.com\/[^/\s"']+\/[^/\s"']+\/([^/\s"']+)\//g
    )) {
      const ref = match[1];
      if (/^[0-9a-f]{40}$/i.test(ref)) continue;
      if (ref === "${SCOUT_INSTALL_COMMIT}") {
        const pinnedCommit = source.match(
          /SCOUT_INSTALL_COMMIT:\s*([0-9a-f]{40})\b/i
        )?.[1];
        const pinnedDigest = source.match(
          /SCOUT_INSTALL_SHA256:\s*([0-9a-f]{64})\b/i
        )?.[1];
        if (pinnedCommit && pinnedDigest) continue;
      }
      failures.push(`${filename}: raw GitHub download is not commit-pinned`);
    }
    if (/curl[^\n|]*\|\s*(?:ba)?sh\b/.test(source)) {
      failures.push(`${filename}: remote content is piped directly to a shell`);
    }
  }
  return failures;
}

function audit(component) {
  const result = spawnSync(
    "yarn",
    ["audit", "--groups", "dependencies", "--level", "high", "--json"],
    {
      cwd: path.join(repoRoot, component),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  if (result.error) throw result.error;
  const advisories = [];
  let summary = null;
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record.type === "auditSummary") summary = record.data;
      if (record.type === "auditAdvisory")
        advisories.push(record.data.advisory);
    } catch {}
  }
  if (!summary) {
    throw new Error(
      `${component}: yarn audit returned no summary (${String(
        result.stderr || result.stdout || `exit ${result.status}`
      ).trim()})`
    );
  }
  return { advisories, summary };
}

function activePolicy(component, moduleName) {
  const entries = policy.highSeverityPolicies?.[component] || [];
  return entries.find((entry) => entry.modules?.includes(moduleName));
}

function validatePolicy(component, moduleName, entry) {
  if (!entry) return `${component}:${moduleName} has no High policy`;
  if (!entry.owner || !entry.mitigation)
    return `${component}:${moduleName} policy lacks owner or mitigation`;
  const expiry = new Date(`${entry.expiresAt}T23:59:59.999Z`);
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now())
    return `${component}:${moduleName} policy expired on ${entry.expiresAt}`;
  return null;
}

const report = { ok: true, components: {}, failures: [] };
report.failures.push(...workflowSupplyChainFailures());
for (const component of components) {
  try {
    const result = audit(component);
    const critical = new Set();
    const high = new Set();
    for (const advisory of result.advisories) {
      if (advisory?.severity === "critical") critical.add(advisory.module_name);
      if (advisory?.severity === "high") high.add(advisory.module_name);
    }
    for (const moduleName of critical) {
      report.failures.push(
        `${component}:${moduleName} is Critical; Critical advisories cannot be waived`
      );
    }
    for (const moduleName of high) {
      const failure = validatePolicy(
        component,
        moduleName,
        activePolicy(component, moduleName)
      );
      if (failure) report.failures.push(failure);
    }
    report.components[component] = {
      critical: [...critical].sort(),
      high: [...high].sort(),
      rawVulnerabilities: result.summary.vulnerabilities,
    };
  } catch (error) {
    report.failures.push(`${component}: ${error.message}`);
  }
}

report.ok = report.failures.length === 0;
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
