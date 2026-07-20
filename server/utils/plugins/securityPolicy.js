const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { safeJsonParse } = require("../http");
const { storagePath } = require("../environment");
const { metrics } = require("../observability/metrics");

const SAFE_INHERITED_ENV = new Set([
  "PATH",
  "NODE_PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "NODE_ENV",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
]);

const SENSITIVE_KEY =
  /(secret|token|password|passwd|private.?key|api.?key|authorization|cookie|credential)/i;

function compactList(value, max = 100) {
  return Array.isArray(value)
    ? [
        ...new Set(
          value.map((entry) => String(entry || "").trim()).filter(Boolean)
        ),
      ].slice(0, max)
    : [];
}

function policyMode(env = process.env) {
  const configured = String(env.ATHENA_PLUGIN_SECURITY_V2 || "").toLowerCase();
  if (["off", "false"].includes(configured)) return "off";
  if (["warn", "shadow"].includes(configured)) return "warn";
  if (["enforce", "true"].includes(configured)) return "enforce";
  return env.NODE_ENV === "production" ? "enforce" : "warn";
}

function normalizeCapabilityManifest(value = {}) {
  const parsed =
    typeof value === "string" ? safeJsonParse(value, {}) : value || {};
  return {
    version: Math.max(Number(parsed.version) || 1, 1),
    tools: compactList(parsed.tools),
    scheduledAutoApprove: compactList(parsed.scheduledAutoApprove),
    environment: compactList(parsed.environment),
    secrets: compactList(parsed.secrets),
    networkDomains: compactList(parsed.networkDomains).map((entry) =>
      entry.toLowerCase()
    ),
    filesystem: {
      read: compactList(parsed.filesystem?.read),
      write: compactList(parsed.filesystem?.write),
    },
    isolation: String(parsed.isolation || "").toLowerCase() || null,
    trustLevel: String(parsed.trustLevel || "untrusted").toLowerCase(),
    allowHighRisk: parsed.allowHighRisk === true,
    maxCostUsd:
      Number.isFinite(Number(parsed.maxCostUsd)) &&
      Number(parsed.maxCostUsd) >= 0
        ? Number(parsed.maxCostUsd)
        : null,
    maxToolCalls:
      Number.isInteger(Number(parsed.maxToolCalls)) &&
      Number(parsed.maxToolCalls) > 0
        ? Math.min(Number(parsed.maxToolCalls), 100)
        : null,
  };
}

function serviceIdentity(name, server = {}) {
  const stable = JSON.stringify({
    name: String(name || "unknown"),
    type: server.type || (server.command ? "stdio" : "http"),
    command: server.command || null,
    args: Array.isArray(server.args) ? server.args : [],
    url: server.url || null,
  });
  return `plugin:${crypto.createHash("sha256").update(stable).digest("hex").slice(0, 24)}`;
}

function hostMatches(hostname, pattern) {
  const host = String(hostname || "").toLowerCase();
  const allowed = String(pattern || "").toLowerCase();
  if (!host || !allowed) return false;
  if (allowed.startsWith("*.")) {
    const suffix = allowed.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === allowed;
}

function argumentValue(args, name) {
  const prefix = `${name}=`;
  const inline = args.find((entry) => String(entry).startsWith(prefix));
  if (inline) return String(inline).slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function hardenedContainerViolations(server, manifest) {
  const args = Array.isArray(server?.args) ? server.args.map(String) : [];
  const violations = [];
  if (!args.includes("run"))
    violations.push("container_run_subcommand_required");
  if (!args.includes("--rm")) violations.push("container_ephemeral_required");
  if (!args.includes("--read-only"))
    violations.push("container_read_only_root_required");
  if (String(argumentValue(args, "--network") || "").toLowerCase() !== "none")
    violations.push("container_network_none_required");
  if (String(argumentValue(args, "--cap-drop") || "").toUpperCase() !== "ALL")
    violations.push("container_capabilities_drop_required");
  if (
    String(argumentValue(args, "--security-opt") || "").toLowerCase() !==
    "no-new-privileges"
  )
    violations.push("container_no_new_privileges_required");
  if (!argumentValue(args, "--pids-limit"))
    violations.push("container_pid_limit_required");
  const containerUser = String(argumentValue(args, "--user") || "").trim();
  if (!containerUser || /^(0|root)(:|$)/i.test(containerUser))
    violations.push("container_non_root_user_required");
  if (
    args.some(
      (entry) =>
        entry === "--privileged" ||
        entry.startsWith("--device") ||
        entry.startsWith("--cap-add") ||
        entry === "-v" ||
        entry.startsWith("--volume") ||
        entry.startsWith("--mount") ||
        /^(--pid|--ipc|--userns)=host$/i.test(entry)
    )
  )
    violations.push("container_host_access_forbidden");
  if (manifest.networkDomains.length)
    violations.push("untrusted_container_network_egress_unsupported");
  if (manifest.filesystem.read.length || manifest.filesystem.write.length)
    violations.push("untrusted_container_host_filesystem_unsupported");
  return violations;
}

function remoteUrlViolations(rawUrl, manifest) {
  const violations = [];
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return ["remote_url_invalid"];
  }
  if (!["http:", "https:"].includes(url.protocol))
    violations.push("remote_protocol_forbidden");
  if (
    !manifest.networkDomains.some((domain) =>
      hostMatches(url.hostname.toLowerCase(), domain)
    )
  )
    violations.push("remote_domain_not_allowlisted");
  return violations;
}

function createPolicyFetch({ policy, fetchImpl = global.fetch } = {}) {
  if (typeof fetchImpl !== "function")
    throw new Error("MCP policy fetch implementation is unavailable.");
  const mode = policy?.mode || "enforce";
  const manifest = policy?.manifest || normalizeCapabilityManifest();
  return async (input, init = {}) => {
    let request = new Request(input, { ...init, redirect: "manual" });
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      const violations = remoteUrlViolations(request.url, manifest);
      if (violations.length && mode === "enforce") {
        const error = new Error(
          "MCP remote destination violates capability policy."
        );
        error.code = "MCP_REMOTE_DESTINATION_DENIED";
        error.violations = violations;
        throw error;
      }
      if (violations.length && mode === "warn") {
        console.warn("[PluginSecurity] MCP remote destination warning", {
          host: new URL(request.url).hostname,
          violations,
        });
      }
      const response = await fetchImpl(request);
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      if (redirectCount === 5) {
        await response.body?.cancel?.();
        const error = new Error("MCP remote redirect limit exceeded.");
        error.code = "MCP_REMOTE_REDIRECT_LIMIT";
        throw error;
      }
      if (!["GET", "HEAD"].includes(request.method.toUpperCase())) {
        await response.body?.cancel?.();
        const error = new Error("MCP non-idempotent redirects are forbidden.");
        error.code = "MCP_REMOTE_REDIRECT_REPLAY_FORBIDDEN";
        throw error;
      }
      const nextUrl = new URL(location, request.url);
      const headers = new Headers(request.headers);
      if (nextUrl.origin !== new URL(request.url).origin) {
        headers.delete("authorization");
        headers.delete("cookie");
        headers.delete("proxy-authorization");
      }
      await response.body?.cancel?.();
      request = new Request(nextUrl, {
        method: request.method,
        headers,
        redirect: "manual",
      });
    }
    throw new Error("MCP remote redirect loop terminated unexpectedly.");
  };
}

function assertMCPServerPolicy({ name, server, type, env = process.env }) {
  const mode = policyMode(env);
  const rawManifest = server?.anythingllm?.capabilities;
  const manifest = normalizeCapabilityManifest(rawManifest);
  const violations = [];
  if (!rawManifest || typeof rawManifest !== "object")
    violations.push("capability_manifest_required");
  if (
    type === "stdio" &&
    !["process", "container"].includes(manifest.isolation)
  )
    violations.push("stdio_process_or_container_isolation_required");
  if (
    type === "stdio" &&
    manifest.isolation === "process" &&
    manifest.trustLevel !== "trusted"
  )
    violations.push("untrusted_stdio_requires_container_isolation");
  if (
    type === "stdio" &&
    manifest.isolation === "container" &&
    !["docker", "podman"].includes(path.basename(String(server.command || "")))
  )
    violations.push("container_isolation_command_required");
  if (
    type === "stdio" &&
    manifest.isolation === "container" &&
    manifest.trustLevel !== "trusted"
  )
    violations.push(...hardenedContainerViolations(server, manifest));
  if (type !== "stdio") {
    violations.push(...remoteUrlViolations(server.url, manifest));
  }
  const explicitEnvironment =
    server?.env && typeof server.env === "object" ? server.env : {};
  for (const [key, value] of Object.entries(explicitEnvironment)) {
    const sourceReference = /^\$\{env:([A-Z0-9_]+)\}$/i.exec(
      String(value || "")
    );
    const sourceName = sourceReference?.[1] || null;
    const declaredEnvironment =
      manifest.environment.includes(key) ||
      (sourceName && manifest.environment.includes(sourceName));
    const declaredSecret =
      manifest.secrets.includes(key) ||
      (sourceName && manifest.secrets.includes(sourceName));
    const sensitiveReference =
      SENSITIVE_KEY.test(key) || (sourceName && SENSITIVE_KEY.test(sourceName));
    if (!declaredEnvironment && !declaredSecret)
      violations.push("plugin_environment_capability_required");
    if (sensitiveReference && !declaredSecret)
      violations.push("plugin_secret_capability_required");
    if (!sourceReference && SENSITIVE_KEY.test(key))
      violations.push("plugin_secret_literal_forbidden");
  }
  const explicitHeaders =
    server?.headers && typeof server.headers === "object" ? server.headers : {};
  for (const [key, value] of Object.entries(explicitHeaders)) {
    const sourceReference = /^\$\{env:([A-Z0-9_]+)\}$/i.exec(
      String(value || "")
    );
    const sourceName = sourceReference?.[1] || null;
    const sensitiveHeader = SENSITIVE_KEY.test(key);
    if (sensitiveHeader && !sourceReference)
      violations.push("plugin_header_secret_literal_forbidden");
    if (
      sourceName &&
      !manifest.secrets.includes(sourceName) &&
      !manifest.secrets.includes(key)
    )
      violations.push("plugin_header_secret_capability_required");
  }
  if (violations.length && mode === "enforce") {
    metrics.pluginPolicyDecisions.inc({
      kind: "mcp_start",
      decision: "denied",
    });
    const error = new Error(
      `MCP server ${name} violates plugin security policy.`
    );
    error.code = "MCP_CAPABILITY_POLICY_DENIED";
    error.violations = violations;
    throw error;
  }
  if (violations.length && mode === "warn") {
    metrics.pluginPolicyDecisions.inc({
      kind: "mcp_start",
      decision: "warning",
    });
    console.warn("[PluginSecurity] MCP policy warning", {
      serviceIdentity: serviceIdentity(name, server),
      violations,
    });
  }
  if (!violations.length)
    metrics.pluginPolicyDecisions.inc({
      kind: "mcp_start",
      decision: "allowed",
    });
  return {
    mode,
    manifest,
    violations,
    serviceIdentity: serviceIdentity(name, server),
  };
}

function resolveConfiguredEnvironment({
  server,
  manifest,
  inherited = process.env,
  mode = "enforce",
}) {
  const explicit =
    server?.env && typeof server.env === "object" ? server.env : {};
  const allowedSecretNames = new Set(manifest.secrets);
  const allowedEnvironmentNames = new Set(manifest.environment);
  const result = {};
  for (const [key, rawValue] of Object.entries(explicit)) {
    const reference = /^\$\{env:([A-Z0-9_]+)\}$/i.exec(String(rawValue || ""));
    if (!reference) {
      result[key] = String(rawValue);
      continue;
    }
    const sourceName = reference[1];
    if (
      mode === "enforce" &&
      !allowedSecretNames.has(sourceName) &&
      !allowedEnvironmentNames.has(sourceName) &&
      !allowedEnvironmentNames.has(key)
    ) {
      const error = new Error(
        `Environment source ${sourceName} is not declared by the plugin.`
      );
      error.code = "MCP_ENVIRONMENT_CAPABILITY_DENIED";
      throw error;
    }
    if (inherited[sourceName] === undefined) {
      const error = new Error(
        `Declared plugin secret ${sourceName} is unavailable.`
      );
      error.code = "MCP_SECRET_UNAVAILABLE";
      throw error;
    }
    result[key] = String(inherited[sourceName]);
  }
  return result;
}

function resolveConfiguredHeaders({
  server,
  manifest,
  inherited = process.env,
  mode = "enforce",
}) {
  const explicit =
    server?.headers && typeof server.headers === "object" ? server.headers : {};
  const allowedSecrets = new Set(manifest.secrets);
  return Object.fromEntries(
    Object.entries(explicit).map(([key, rawValue]) => {
      const reference = /^\$\{env:([A-Z0-9_]+)\}$/i.exec(
        String(rawValue || "")
      );
      if (!reference) return [key, String(rawValue)];
      const sourceName = reference[1];
      if (
        mode === "enforce" &&
        !allowedSecrets.has(sourceName) &&
        !allowedSecrets.has(key)
      ) {
        const error = new Error(
          `Header secret ${sourceName} is not declared by the plugin.`
        );
        error.code = "MCP_SECRET_CAPABILITY_DENIED";
        throw error;
      }
      if (inherited[sourceName] === undefined) {
        const error = new Error(
          `Declared plugin secret ${sourceName} is unavailable.`
        );
        error.code = "MCP_SECRET_UNAVAILABLE";
        throw error;
      }
      return [key, String(inherited[sourceName])];
    })
  );
}

function buildMCPEnvironment({ server, shellEnv = {}, policy }) {
  const identity = policy.serviceIdentity;
  const runtimeDir = storagePath(
    "plugins",
    "runtime",
    identity.replace(":", "-")
  );
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(runtimeDir, 0o700);
  } catch {}
  const env = {};
  for (const key of SAFE_INHERITED_ENV) {
    const value = shellEnv[key] ?? process.env[key];
    if (value !== undefined) env[key] = String(value);
  }
  env.PATH = env.PATH || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  env.NODE_PATH = env.NODE_PATH || "/usr/local/lib/node_modules";
  env.ATHENA_PLUGIN_SERVICE_ID = identity;
  env.ATHENA_PLUGIN_RUNTIME_DIR = runtimeDir;
  env.TMPDIR = runtimeDir;
  Object.assign(
    env,
    resolveConfiguredEnvironment({
      server,
      manifest: policy.manifest,
      inherited: process.env,
      mode: policy.mode,
    })
  );
  return env;
}

function toolAllowed(manifest, toolName, mode = "enforce") {
  if (mode !== "enforce") return true;
  return manifest.tools.includes(String(toolName));
}

function walkInvocationValues(value, visit, key = "", depth = 0) {
  if (depth > 6) return;
  if (Array.isArray(value)) {
    value
      .slice(0, 100)
      .forEach((entry) => walkInvocationValues(entry, visit, key, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") {
    visit(key, value);
    return;
  }
  Object.entries(value)
    .slice(0, 100)
    .forEach(([childKey, entry]) =>
      walkInvocationValues(entry, visit, childKey, depth + 1)
    );
}

function pathWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function invocationKeyMatches(key, candidates = []) {
  const normalized = String(key || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  return normalized
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .some((part) => candidates.includes(part));
}

function assertToolInvocationPolicy({ policy, args = {} }) {
  const manifest = policy?.manifest || normalizeCapabilityManifest();
  const allowedRoots = [
    ...manifest.filesystem.read,
    ...manifest.filesystem.write,
  ].map((entry) => path.resolve(entry));
  const violations = [];
  walkInvocationValues(args, (key, rawValue) => {
    if (typeof rawValue !== "string" || !rawValue.trim()) return;
    if (
      invocationKeyMatches(key, [
        "url",
        "uri",
        "endpoint",
        "webhook",
        "href",
        "link",
      ])
    ) {
      try {
        const url = new URL(rawValue);
        if (
          !manifest.networkDomains.some((domain) =>
            hostMatches(url.hostname, domain)
          )
        )
          violations.push("tool_network_destination_denied");
      } catch {}
    }
    if (
      invocationKeyMatches(key, [
        "path",
        "file",
        "filepath",
        "folder",
        "directory",
        "cwd",
        "root",
      ])
    ) {
      const candidate = path.resolve(rawValue);
      if (!allowedRoots.some((root) => pathWithin(candidate, root)))
        violations.push("tool_filesystem_path_denied");
    }
  });
  if (violations.length) {
    metrics.pluginPolicyDecisions.inc({
      kind: "mcp_tool",
      decision: policy?.mode === "enforce" ? "denied" : "warning",
    });
    if (policy?.mode !== "enforce") return true;
    const error = new Error("MCP tool invocation violates capability policy.");
    error.code = "MCP_TOOL_CAPABILITY_DENIED";
    error.violations = [...new Set(violations)];
    throw error;
  }
  metrics.pluginPolicyDecisions.inc({ kind: "mcp_tool", decision: "allowed" });
  return true;
}

function scheduledApprovalDecision({ job, skillName, forceApproval = false }) {
  const manifest = normalizeCapabilityManifest(job?.capabilityManifest);
  const tool = String(skillName || "").trim();
  const explicitlyAllowed = manifest.scheduledAutoApprove.includes(tool);
  const highRisk =
    forceApproval || /(shell|delete|send|write|move|copy|edit)/i.test(tool);
  const wouldApprove =
    explicitlyAllowed && (!highRisk || manifest.allowHighRisk);
  const mode = policyMode();
  const approved = mode === "enforce" ? wouldApprove : true;
  metrics.pluginPolicyDecisions.inc({
    kind: "scheduled_tool",
    decision:
      mode === "warn" && !wouldApprove
        ? "warning"
        : approved
          ? "allowed"
          : "denied",
  });
  return {
    approved,
    message: approved
      ? wouldApprove
        ? "Approved by the scheduled job capability manifest."
        : "Approved while plugin security is in warning-only mode; production enforcement would deny this action."
      : "Denied: this scheduled action is not explicitly granted by the job capability manifest.",
    serviceIdentity: `scheduled-job:${Number(job?.id) || "unknown"}`,
    tool,
    highRisk,
    policyMode: mode,
  };
}

function redactForLog(value, depth = 0) {
  if (depth > 5) return "[truncated]";
  if (Array.isArray(value))
    return value.slice(0, 30).map((item) => redactForLog(item, depth + 1));
  if (!value || typeof value !== "object") {
    const text = typeof value === "string" ? value : null;
    return text && text.length > 500 ? `${text.slice(0, 500)}…` : value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 50)
      .map(([key, entry]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[redacted]" : redactForLog(entry, depth + 1),
      ])
  );
}

module.exports = {
  SAFE_INHERITED_ENV,
  assertMCPServerPolicy,
  assertToolInvocationPolicy,
  buildMCPEnvironment,
  createPolicyFetch,
  normalizeCapabilityManifest,
  policyMode,
  redactForLog,
  scheduledApprovalDecision,
  serviceIdentity,
  toolAllowed,
  _internals: {
    hostMatches,
    hardenedContainerViolations,
    invocationKeyMatches,
    pathWithin,
    resolveConfiguredEnvironment,
    resolveConfiguredHeaders,
    remoteUrlViolations,
  },
};
