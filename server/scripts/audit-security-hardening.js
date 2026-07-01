#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const repoRoot = path.resolve(__dirname, "../..");
const allowlistPath = path.join(__dirname, "security-hardening-allowlist.json");
const routeCasesPath = path.join(__dirname, "request-signing-route-cases.json");

process.env.NODE_ENV ||= "development";
process.env.STORAGE_DIR ||= path.join(repoRoot, "server/storage");
process.env.ANYTHINGLLM_ENV_STORAGE_APPLIED ||= "true";

const originalConsoleLog = console.log;
console.log = () => {};
const { isHighRiskSignedRequest } = require("../utils/requestSigning");
console.log = originalConsoleLog;

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist", "build"].includes(entry.name)) {
      continue;
    }
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(target, files);
    else files.push(target);
  }
  return files;
}

function rel(file) {
  return path.relative(repoRoot, file);
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function readJson(file, fallback) {
  try {
    return JSON.parse(read(file));
  } catch {
    return fallback;
  }
}

const allowlist = readJson(allowlistPath, []);
const routeCases = readJson(routeCasesPath, { signed: [], unsigned: [] });

function allowlistMatches(type, value) {
  return allowlist.some((entry) => {
    if (entry.type !== type) return false;
    try {
      return new RegExp(entry.pattern).test(value);
    } catch {
      return false;
    }
  });
}

function comparableRoutePath(value = "") {
  const route = String(value || "/").split("?")[0] || "/";
  return route.startsWith("/api/") ? route.slice(4) : route;
}

function discoverEndpointRoutes() {
  const endpointsRoot = path.join(repoRoot, "server/endpoints");
  const routePattern = /app\.(post|put|patch|delete)\(\s*(["'`])([^"'`]+)\2/g;
  return walk(endpointsRoot)
    .filter((file) => /\.(js|mjs|cjs)$/.test(file))
    .flatMap((file) => {
      const source = read(file);
      const routes = [];
      let match;
      while ((match = routePattern.exec(source))) {
        routes.push({
          method: match[1].toUpperCase(),
          path: match[3],
          file: rel(file),
          route: `${match[1].toUpperCase()} ${match[3]}`,
        });
      }
      return routes;
    });
}

function routeLooksSecuritySensitive({ method, path }) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(normalizedMethod)) return false;

  const routePath = comparableRoutePath(path);
  if (isHighRiskSignedRequest({ method: normalizedMethod, path: routePath })) {
    return true;
  }

  if (/^\/v1\//.test(routePath)) return true;
  if (/^\/admin(\/|$)/.test(routePath)) return true;
  if (/^\/client-identity\/(revoke|rotate)/.test(routePath)) return true;
  if (/^\/vault\/items(\/|$)/.test(routePath)) return true;
  if (/^\/auth\/(passkeys|trusted-devices|zk-login\/devices)/.test(routePath)) {
    return true;
  }
  if (/^\/system\/(user|remove-|prompt-variables)(\/|$)/.test(routePath)) {
    return true;
  }
  if (/^\/crypto-component-experiment(?:\/[^/]+)?\/config$/.test(routePath)) {
    return true;
  }
  if (
    normalizedMethod === "POST" &&
    /^\/workspace\/[^/]+\/tool-approval$/.test(routePath)
  ) {
    return true;
  }
  if (
    normalizedMethod === "DELETE" &&
    /^\/workspace\/[^/]+(\/remove-and-unembed)?$/.test(routePath)
  ) {
    return true;
  }
  if (
    /^\/(workspace\/[^/]+\/)?reader-documents\/[^/]+$/.test(routePath) &&
    normalizedMethod === "DELETE"
  ) {
    return true;
  }

  return false;
}

function auditHighRiskSigning() {
  const findings = [];
  for (const [method, route] of routeCases.signed || []) {
    if (!isHighRiskSignedRequest({ method, path: route })) {
      findings.push({
        type: "missing_high_risk_signature",
        route: `${method} ${route}`,
      });
    }
  }
  for (const [method, route] of routeCases.unsigned || []) {
    if (isHighRiskSignedRequest({ method, path: route })) {
      findings.push({
        type: "unexpected_high_risk_signature",
        route: `${method} ${route}`,
      });
    }
  }
  for (const route of discoverEndpointRoutes()) {
    if (!routeLooksSecuritySensitive(route)) continue;
    if (isHighRiskSignedRequest(route)) continue;
    if (allowlistMatches("route", route.route)) continue;
    findings.push({
      type: "discovered_high_risk_route_without_signature",
      route: route.route,
      file: route.file,
    });
  }
  return findings;
}

function auditFrontendCommunicationBoundaries() {
  const frontend = path.join(repoRoot, "frontend/src");
  const allowed = [/^frontend\/src\/lib\/communication\//];
  const pattern =
    /fetch\s*\(|fetchEventSource|new\s+WebSocket|EventSource|XMLHttpRequest|postMessage|ipcRenderer|invoke\s*\(/;
  return walk(frontend)
    .filter((file) => /\.(js|jsx|ts|tsx|mjs|cjs)$/.test(file))
    .flatMap((file) => {
      const relative = rel(file);
      if (allowed.some((entry) => entry.test(relative))) return [];
      if (allowlistMatches("frontend_communication", relative)) return [];
      return read(file)
        .split("\n")
        .map((line, index) =>
          pattern.test(line)
            ? {
                type: "unexpected_frontend_communication",
                file: relative,
                line: index + 1,
                snippet: line.trim().slice(0, 160),
              }
            : null
        )
        .filter(Boolean);
    });
}

function auditSensitiveLogs() {
  const roots = ["server", "collector"].map((item) =>
    path.join(repoRoot, item)
  );
  const sensitive =
    /authorization|cookie|bearer|secret|signature|api[_-]?key|privateKey|signingSecret|auth[_ -]?token|temporary[_ -]?auth[_ -]?token|deviceToken|registrationToken/i;
  const allowed = [
    /server\/public\//,
    /utils\/security\/redaction\.js$/,
    /utils\/logger\/index\.js$/,
    /scripts\/audit-security-hardening\.js$/,
    /__tests__\//,
    /swagger\//,
    /node_modules\//,
  ];
  return roots.flatMap((root) =>
    walk(root)
      .filter((file) => /\.(js|mjs|cjs)$/.test(file))
      .flatMap((file) => {
        const relative = rel(file);
        if (allowed.some((entry) => entry.test(relative))) return [];
        if (allowlistMatches("sensitive_log", relative)) return [];
        const lines = read(file).split("\n");
        return lines
          .map((line, index) => {
            const context = lines.slice(index, index + 8).join(" ");
            const contextTarget = `${relative}:${index + 1} ${context}`;
            if (allowlistMatches("sensitive_log", contextTarget)) return null;
            const isLog =
              /console\.(log|warn|error|debug)|EventLogs\.logEvent|this\.log\(/.test(
                line
              );
            const hasSensitiveLog = isLog && sensitive.test(line);
            const hasSensitiveEventLog =
              line.includes("EventLogs.logEvent") && sensitive.test(context);
            if (!hasSensitiveLog && !hasSensitiveEventLog) return null;
            if (
              relative === "server/endpoints/system.js" &&
              line.includes("failed_login_invalid_temporary_auth_token")
            ) {
              return null;
            }
            return {
              type: "sensitive_log_candidate",
              file: relative,
              line: index + 1,
              snippet: line.trim().slice(0, 160),
            };
          })
          .filter(Boolean);
      })
  );
}

function main() {
  const findings = [
    ...auditHighRiskSigning(),
    ...auditFrontendCommunicationBoundaries(),
    ...auditSensitiveLogs(),
  ];
  console.log(
    JSON.stringify(
      {
        success: findings.length === 0,
        findingCount: findings.length,
        routeCount: discoverEndpointRoutes().length,
        allowlistCount: allowlist.length,
        findings,
      },
      null,
      2
    )
  );
  process.exit(findings.length ? 1 : 0);
}

main();
