const fs = require("fs");
const path = require("path");

const DATA_ACCESS_MODES = Object.freeze({
  observe: "observe",
  warn: "warn",
  enforce: "enforce",
});

const SCAN_ROOTS = Object.freeze(["endpoints", "services", "utils", "jobs"]);
const MAX_FINDINGS = 500;
const MODEL_REQUIRE_PATTERN = /require\(["'](?:\.\.\/)+models\/([^"']+)["']\)/g;
const PRISMA_CLIENT_REQUIRE_PATTERN = /require\(["']@prisma\/client["']\)/g;
const PRISMA_ACCESS_PATTERN = /\bprisma\.(?!_runtimeDataModel\b)/g;
const DEFAULT_BASELINE_PATH = path.join(
  __dirname,
  "dataAccessBypassBaseline.json"
);

const DIRECT_ACCESS_ALLOWLIST = Object.freeze([
  {
    pattern: /^utils\/prisma\/index\.js$/,
    reason: "Prisma client construction boundary.",
  },
  {
    pattern: /^utils\/authPrisma\/index\.js$/,
    reason: "Shared auth Prisma client construction boundary.",
  },
  {
    pattern: /^utils\/database\/index\.js$/,
    reason: "Database bootstrap and migration boundary.",
  },
  {
    pattern: /^utils\/accountDeletion\.js$/,
    reason:
      "Account deletion maintenance boundary for cross-environment shadow-user checks.",
  },
  {
    pattern: /^utils\/systemPatrol\/index\.js$/,
    reason: "System patrol maintenance boundary for isolated health checks.",
  },
  {
    pattern: /^utils\/dataAccess\//,
    reason: "DataAccessCenter implementation boundary.",
  },
  {
    pattern: /^utils\/security\//,
    reason: "Low-level security utility boundary.",
  },
  {
    pattern: /^utils\/authz\/sensitiveSessions\.js$/,
    reason: "Sensitive session runtime store boundary.",
  },
  {
    pattern: /^utils\/environment\/index\.js$/,
    reason: "Storage and database path configuration boundary.",
  },
]);

const SCRIPT_ACCESS_ALLOWLIST = Object.freeze([
  {
    pattern: /^scripts\/audit-encryption-coverage\.js$/,
    category: "diagnostic",
    risk: "sensitive-read",
    reason:
      "Encryption coverage audit intentionally introspects encrypted tables and columns.",
    action: "keep-script-boundary",
  },
  {
    pattern: /^scripts\/audit-shared-auth-identity\.js$/,
    category: "diagnostic",
    risk: "sensitive-read",
    reason:
      "Shared-auth identity audit reads the shared auth database with a separate Prisma client.",
    action: "keep-script-boundary",
  },
  {
    pattern: /^scripts\/backfillKnowledgeGraph\.js$/,
    category: "maintenance",
    risk: "internal-write",
    reason:
      "Knowledge graph backfill runs existing knowledgeGraph maintenance utilities from CLI.",
    action: "prefer-data-access-where-available",
  },
  {
    pattern: /^scripts\/diagnose-deepseek-cache\.js$/,
    category: "diagnostic",
    risk: "internal-read",
    reason:
      "Provider cache diagnosis queries model/cache settings for support.",
    action: "keep-script-boundary",
  },
  {
    pattern: /^scripts\/encrypt-workspace-chat-history\.js$/,
    category: "migration",
    risk: "sensitive-write",
    reason:
      "One-time workspace chat encryption migration needs raw encrypted row inspection.",
    action: "keep-migration-boundary",
  },
  {
    pattern: /^scripts\/maintain-local-auth\.js$/,
    category: "bootstrap",
    risk: "sensitive-write",
    reason:
      "Local auth maintenance reconciles shared auth and local shadow users for repair.",
    action: "prefer-auth-identity-repository",
  },
  {
    pattern: /^scripts\/migrate-chat-history-serial-encryption\.js$/,
    category: "migration",
    risk: "sensitive-write",
    reason:
      "Serial encryption migration scans and rewrites chat rows in controlled batches.",
    action: "keep-migration-boundary",
  },
  {
    pattern: /^scripts\/migrate-high-risk-encryption\.js$/,
    category: "migration",
    risk: "secret-write",
    reason:
      "High-risk encryption migration intentionally wraps secret-bearing tables.",
    action: "keep-migration-boundary",
  },
  {
    pattern: /^scripts\/migrate-request-signing-secrets\.js$/,
    category: "migration",
    risk: "secret-write",
    reason:
      "Request-signing secret migration needs raw rows to encrypt legacy values.",
    action: "keep-migration-boundary",
  },
  {
    pattern: /^scripts\/migrate-shared-auth-db\.js$/,
    category: "migration",
    risk: "sensitive-write",
    reason:
      "Shared-auth DB migration constructs and copies auth identities across databases.",
    action: "keep-migration-boundary",
  },
  {
    pattern: /^scripts\/qa-account-delete-ban-devprod\.js$/,
    category: "qa",
    risk: "sensitive-write",
    reason:
      "Manual QA script validates account-deletion ban behavior across environments.",
    action: "keep-script-boundary",
  },
  {
    pattern: /^scripts\/recomputeKnowledgeNodeMetrics\.js$/,
    category: "maintenance",
    risk: "user-write",
    reason:
      "CLI recompute operation marks graph metrics stale and reruns metric jobs.",
    action: "prefer-data-access-where-available",
  },
  {
    pattern: /^scripts\/recover-vectors\.js$/,
    category: "recovery",
    risk: "user-write",
    reason:
      "Vector recovery rebuilds workspace_documents/document_vectors from batch files.",
    action: "prefer-maintenance-repository",
  },
  {
    pattern: /^scripts\/rotate-encryption-master-key\.js$/,
    category: "migration",
    risk: "secret-write",
    reason:
      "Encryption master key rotation must rewrap encrypted rows in a controlled script.",
    action: "keep-migration-boundary",
  },
]);

const runtimeBypassStats = {
  total: 0,
  byDomain: {},
  recent: [],
};

function serverRoot() {
  return path.resolve(__dirname, "../..");
}

function dataAccessMode() {
  const value = String(
    process.env.DATA_ACCESS_MODE || DATA_ACCESS_MODES.observe
  )
    .trim()
    .toLowerCase();
  return Object.values(DATA_ACCESS_MODES).includes(value)
    ? value
    : DATA_ACCESS_MODES.observe;
}

function compactString(value = "", max = 180) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function relativeServerPath(filePath = "") {
  return path.relative(serverRoot(), filePath).replace(/\\/g, "/");
}

function lineColumnFor(content = "", index = 0) {
  const before = content.slice(0, index);
  const lines = before.split("\n");
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}

function allowlistMatch(relativePath = "") {
  return DIRECT_ACCESS_ALLOWLIST.find((entry) =>
    entry.pattern.test(relativePath)
  );
}

function scriptAllowlistMatch(relativePath = "") {
  return SCRIPT_ACCESS_ALLOWLIST.find((entry) =>
    entry.pattern.test(relativePath)
  );
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "storage" ||
        entry.name.startsWith(".")
      )
        return [];
      return walkFiles(target);
    }
    return entry.isFile() && entry.name.endsWith(".js") ? [target] : [];
  });
}

function domainFromPath(relativePath = "", match = "") {
  const value = `${relativePath} ${match}`.toLowerCase();
  if (value.includes("reader")) return "readerLibrary";
  if (value.includes("workspace_thread") || value.includes("thread"))
    return "workspaceThread";
  if (value.includes("workspace_chat") || value.includes("chat"))
    return "workspaceChat";
  if (value.includes("workspace")) return "workspace";
  if (value.includes("document_vector") || value.includes("vector"))
    return "documentVector";
  if (value.includes("documentindex") || value.includes("indexstatus"))
    return "documentIndexStatus";
  if (value.includes("document")) return "document";
  if (value.includes("vault")) return "vault";
  if (value.includes("crypto")) return "crypto";
  if (value.includes("system") || value.includes("admin")) return "adminSystem";
  if (value.includes("auth") || value.includes("identity"))
    return "authIdentity";
  if (value.includes("userstate") || value.includes("user_state"))
    return "userState";
  if (value.includes("knowledge")) return "knowledgeGraph";
  if (value.includes("quiz")) return "quiz";
  return "unknown";
}

function finding({ type, filePath, content, index, match, detail = null }) {
  const relativePath = relativeServerPath(filePath);
  const allowed = allowlistMatch(relativePath);
  const location = lineColumnFor(content, index);
  return {
    type,
    file: relativePath,
    line: location.line,
    column: location.column,
    domain: domainFromPath(relativePath, detail || match),
    match: compactString(match),
    detail: detail ? compactString(detail) : null,
    allowed: Boolean(allowed),
    allowReason: allowed?.reason || null,
  };
}

function findingKey(item = {}) {
  return [
    item.type || "",
    item.file || "",
    item.domain || "",
    item.match || "",
    item.detail || "",
  ].join("|");
}

function compactFindingForBaseline(item = {}) {
  return {
    key: findingKey(item),
    type: item.type,
    file: item.file,
    domain: item.domain,
    match: item.match,
    detail: item.detail || null,
  };
}

function findingCounts(findings = []) {
  const counts = new Map();
  const examples = new Map();
  for (const item of findings) {
    const key = findingKey(item);
    counts.set(key, (counts.get(key) || 0) + 1);
    if (!examples.has(key)) examples.set(key, compactFindingForBaseline(item));
  }
  return { counts, examples };
}

function loadBypassBaseline({
  baselinePath = process.env.DATA_ACCESS_BASELINE_PATH || DEFAULT_BASELINE_PATH,
} = {}) {
  if (!baselinePath || !fs.existsSync(baselinePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  } catch (error) {
    const wrapped = new Error(
      `Unable to read DataAccess baseline: ${error.message}`
    );
    wrapped.code = "DATA_ACCESS_BASELINE_READ_FAILED";
    wrapped.cause = error;
    throw wrapped;
  }
}

function compareFindingsToBaseline(findings = [], baseline = null) {
  const visibleFindings = findings.filter((item) => !item.allowed);
  const actual = findingCounts(visibleFindings);
  const baselineCounts = new Map();
  for (const item of baseline?.findings || []) {
    baselineCounts.set(item.key, Number(item.count || 0));
  }

  const additions = [];
  const resolved = [];
  for (const [key, count] of actual.counts.entries()) {
    const allowedCount = baselineCounts.get(key) || 0;
    if (count > allowedCount) {
      additions.push({
        ...actual.examples.get(key),
        count,
        baselineCount: allowedCount,
        newCount: count - allowedCount,
      });
    }
  }

  for (const item of baseline?.findings || []) {
    const count = actual.counts.get(item.key) || 0;
    if (count < Number(item.count || 0)) {
      resolved.push({
        ...item,
        currentCount: count,
        resolvedCount: Number(item.count || 0) - count,
      });
    }
  }

  return {
    baselinePath:
      process.env.DATA_ACCESS_BASELINE_PATH || DEFAULT_BASELINE_PATH,
    baselineBlocked: Number(baseline?.blocked || 0),
    actualBlocked: visibleFindings.length,
    additions,
    resolved,
    hasNewBypass: additions.length > 0,
  };
}

function buildBypassBaseline(audit = scanBypassAccess({ limit: Infinity })) {
  const visibleFindings = audit.findings.filter((item) => !item.allowed);
  const { counts, examples } = findingCounts(visibleFindings);
  const findings = [...counts.entries()]
    .map(([key, count]) => ({
      ...examples.get(key),
      count,
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    mode: audit.mode,
    scannedFiles: audit.scannedFiles,
    blocked: visibleFindings.length,
    findings,
  };
}

function writeBypassBaseline({
  baselinePath = process.env.DATA_ACCESS_BASELINE_PATH || DEFAULT_BASELINE_PATH,
  audit = scanBypassAccess({ limit: Infinity }),
} = {}) {
  const baseline = buildBypassBaseline(audit);
  fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  return baseline;
}

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const results = [];

  for (const match of content.matchAll(MODEL_REQUIRE_PATTERN)) {
    results.push(
      finding({
        type: "direct-model-import",
        filePath,
        content,
        index: match.index || 0,
        match: match[0],
        detail: match[1],
      })
    );
  }

  for (const match of content.matchAll(PRISMA_CLIENT_REQUIRE_PATTERN)) {
    results.push(
      finding({
        type: "direct-prisma-client-import",
        filePath,
        content,
        index: match.index || 0,
        match: match[0],
        detail: "@prisma/client",
      })
    );
  }

  for (const match of content.matchAll(PRISMA_ACCESS_PATTERN)) {
    results.push(
      finding({
        type: "direct-prisma-access",
        filePath,
        content,
        index: match.index || 0,
        match: match[0],
      })
    );
  }

  return results;
}

function summarizeFindings(findings = []) {
  return findings.reduce(
    (summary, item) => {
      summary.byType[item.type] = (summary.byType[item.type] || 0) + 1;
      summary.byDomain[item.domain] = (summary.byDomain[item.domain] || 0) + 1;
      const root = item.file.split("/")[0] || "unknown";
      summary.byRoot[root] = (summary.byRoot[root] || 0) + 1;
      if (item.allowed) summary.allowed += 1;
      else summary.blocked += 1;
      return summary;
    },
    { byType: {}, byDomain: {}, byRoot: {}, allowed: 0, blocked: 0 }
  );
}

function scanBypassAccess({
  roots = SCAN_ROOTS,
  includeAllowed = false,
  limit = MAX_FINDINGS,
} = {}) {
  const files = roots.flatMap((root) =>
    walkFiles(path.join(serverRoot(), root))
  );
  const allFindings = files.flatMap((filePath) => scanFile(filePath));
  const visibleFindings = includeAllowed
    ? allFindings
    : allFindings.filter((item) => !item.allowed);
  const summary = summarizeFindings(allFindings);
  return {
    mode: dataAccessMode(),
    scannedAt: new Date().toISOString(),
    scannedFiles: files.length,
    findingsCount: allFindings.length,
    visibleFindingsCount: visibleFindings.length,
    ...summary,
    findings: visibleFindings.slice(0, limit),
    truncated: visibleFindings.length > limit,
  };
}

function summarizeScriptFindings(findings = []) {
  return findings.reduce(
    (summary, item) => {
      summary.byType[item.type] = (summary.byType[item.type] || 0) + 1;
      summary.byDomain[item.domain] = (summary.byDomain[item.domain] || 0) + 1;
      summary.byCategory[item.scriptCategory] =
        (summary.byCategory[item.scriptCategory] || 0) + 1;
      summary.byRisk[item.scriptRisk] =
        (summary.byRisk[item.scriptRisk] || 0) + 1;
      if (item.scriptAllowed) summary.classified += 1;
      else summary.unclassified += 1;
      return summary;
    },
    {
      byType: {},
      byDomain: {},
      byCategory: {},
      byRisk: {},
      classified: 0,
      unclassified: 0,
    }
  );
}

function scanScriptAccess({
  roots = ["scripts"],
  includeClassified = true,
  limit = MAX_FINDINGS,
} = {}) {
  const files = roots.flatMap((root) =>
    walkFiles(path.join(serverRoot(), root))
  );
  const allFindings = files.flatMap((filePath) =>
    scanFile(filePath).map((item) => {
      const scriptEntry = scriptAllowlistMatch(item.file);
      return {
        ...item,
        scriptAllowed: Boolean(scriptEntry),
        scriptCategory: scriptEntry?.category || "unclassified",
        scriptRisk: scriptEntry?.risk || "review-required",
        scriptReason: scriptEntry?.reason || null,
        recommendedAction: scriptEntry?.action || "classify-or-migrate",
      };
    })
  );
  const visibleFindings = includeClassified
    ? allFindings
    : allFindings.filter((item) => !item.scriptAllowed);
  const summary = summarizeScriptFindings(allFindings);
  return {
    mode: dataAccessMode(),
    scannedAt: new Date().toISOString(),
    scannedFiles: files.length,
    findingsCount: allFindings.length,
    visibleFindingsCount: visibleFindings.length,
    ...summary,
    findings: visibleFindings.slice(0, limit),
    truncated: visibleFindings.length > limit,
  };
}

function recordBypassAccess({
  domain = "unknown",
  caller = null,
  accessType = "unknown",
  reason = null,
} = {}) {
  runtimeBypassStats.total += 1;
  runtimeBypassStats.byDomain[domain] =
    (runtimeBypassStats.byDomain[domain] || 0) + 1;
  runtimeBypassStats.recent.unshift({
    at: new Date().toISOString(),
    domain,
    caller,
    accessType,
    reason,
  });
  runtimeBypassStats.recent = runtimeBypassStats.recent.slice(0, 80);
}

function runtimeBypassSnapshot() {
  return {
    total: runtimeBypassStats.total,
    byDomain: { ...runtimeBypassStats.byDomain },
    recent: runtimeBypassStats.recent.slice(0, 80),
  };
}

function assertMigrationCompliance(options = {}) {
  const audit = scanBypassAccess(options);
  const baseline = loadBypassBaseline();
  const baselineComparison = compareFindingsToBaseline(
    audit.findings,
    baseline
  );
  audit.baselineComparison = baselineComparison;
  if (
    dataAccessMode() === DATA_ACCESS_MODES.enforce &&
    (process.env.DATA_ACCESS_ENFORCE_FULL === "true"
      ? audit.blocked > 0
      : baselineComparison.hasNewBypass)
  ) {
    const error = new Error(
      process.env.DATA_ACCESS_ENFORCE_FULL === "true"
        ? `DataAccessCenter enforce mode blocked ${audit.blocked} direct data access sites.`
        : `DataAccessCenter enforce mode blocked ${baselineComparison.additions.length} new direct data access signatures.`
    );
    error.code = "DATA_ACCESS_BYPASS_ENFORCED";
    error.audit = audit;
    throw error;
  }
  if (dataAccessMode() === DATA_ACCESS_MODES.warn && audit.blocked > 0) {
    console.warn(
      `[DataAccessCenter] ${audit.blocked} direct data access sites remain; ${baselineComparison.additions.length} are new against baseline.`
    );
  }
  return audit;
}

function resetForTests() {
  runtimeBypassStats.total = 0;
  runtimeBypassStats.byDomain = {};
  runtimeBypassStats.recent = [];
}

module.exports = {
  DATA_ACCESS_MODES,
  DIRECT_ACCESS_ALLOWLIST,
  SCRIPT_ACCESS_ALLOWLIST,
  assertMigrationCompliance,
  buildBypassBaseline,
  compareFindingsToBaseline,
  dataAccessMode,
  findingKey,
  loadBypassBaseline,
  recordBypassAccess,
  resetForTests,
  runtimeBypassSnapshot,
  scanBypassAccess,
  scanScriptAccess,
  writeBypassBaseline,
};
