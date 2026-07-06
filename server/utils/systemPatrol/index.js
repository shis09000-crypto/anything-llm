const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { PrismaClient } = require("@prisma/client");
const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const SystemPatrolData = lazyDataAccessFacade("systemPatrol");
const systemPatrolDb = SystemPatrolData.db;
const {
  appEnvironment,
  authDatabasePath,
  authDatabaseUrl,
  databasePath,
  diagnosticSummary,
  storagePath,
  storageRoot,
  vectorNamespace,
  vectorNamespacePrefix,
} = require("../environment");
const Workspace = SystemPatrolData.workspace;
const {
  DocumentRepository: Document,
} = require("../../repositories/documentRepository");
const {
  DocumentVectorRepository: DocumentVectors,
} = require("../../repositories/documentVectorRepository");
const {
  auditSharedAuthIdentity,
} = require("../../scripts/audit-shared-auth-identity");

const RUN_TABLE = "system_patrol_runs";
const REPAIR_TABLE = "system_patrol_repairs";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const severityRank = { healthy: 0, info: 1, warning: 2, critical: 3 };

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function repairId(action, payload = {}) {
  return crypto
    .createHash("sha256")
    .update(`${action}:${JSON.stringify(payload)}`)
    .digest("hex")
    .slice(0, 24);
}

function checkResult({
  id,
  category,
  status = "healthy",
  severity = "healthy",
  summary,
  evidence = {},
  repairAction = null,
}) {
  return {
    id,
    category,
    status,
    severity,
    summary,
    evidence,
    repairAction,
    requiresConfirm: Boolean(repairAction),
    lastCheckedAt: nowIso(),
  };
}

function summarizeChecks(checks = []) {
  const counts = checks.reduce(
    (acc, check) => {
      acc[check.severity] = (acc[check.severity] || 0) + 1;
      return acc;
    },
    { healthy: 0, info: 0, warning: 0, critical: 0 }
  );
  const worst = checks.reduce(
    (current, check) =>
      severityRank[check.severity] > severityRank[current]
        ? check.severity
        : current,
    "healthy"
  );
  const score = Math.max(
    0,
    100 - counts.critical * 30 - counts.warning * 12 - counts.info * 4
  );
  return {
    status: worst,
    score,
    counts,
    totalChecks: checks.length,
    actionable: checks.filter((check) => check.repairAction).length,
  };
}

async function ensurePatrolTables() {
  await systemPatrolDb.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "${RUN_TABLE}" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "mode" TEXT NOT NULL DEFAULT 'light',
      "status" TEXT NOT NULL DEFAULT 'running',
      "trigger" TEXT NOT NULL DEFAULT 'manual',
      "triggeredBy" INTEGER,
      "summaryScore" INTEGER NOT NULL DEFAULT 0,
      "summaryStatus" TEXT NOT NULL DEFAULT 'unknown',
      "countsJson" TEXT NOT NULL DEFAULT '{}',
      "reportJson" TEXT NOT NULL DEFAULT '{}',
      "error" TEXT,
      "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "completedAt" DATETIME
    )
  `);
  await systemPatrolDb.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "${REPAIR_TABLE}" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "repairId" TEXT NOT NULL UNIQUE,
      "runId" INTEGER,
      "checkId" TEXT NOT NULL,
      "action" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'previewed',
      "previewJson" TEXT NOT NULL DEFAULT '{}',
      "backupPath" TEXT,
      "confirmedBy" INTEGER,
      "resultJson" TEXT NOT NULL DEFAULT '{}',
      "error" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await systemPatrolDb.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "system_patrol_runs_startedAt_idx" ON "${RUN_TABLE}" ("startedAt")`
  );
  await systemPatrolDb.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "system_patrol_repairs_repairId_idx" ON "${REPAIR_TABLE}" ("repairId")`
  );
}

async function createRun({ mode, trigger, triggeredBy }) {
  await ensurePatrolTables();
  await systemPatrolDb.$executeRawUnsafe(
    `INSERT INTO "${RUN_TABLE}" ("mode", "status", "trigger", "triggeredBy", "startedAt")
     VALUES (?, 'running', ?, ?, CURRENT_TIMESTAMP)`,
    mode,
    trigger,
    triggeredBy || null
  );
  const rows = await systemPatrolDb.$queryRawUnsafe(
    `SELECT last_insert_rowid() AS id`
  );
  return Number(rows?.[0]?.id);
}

async function completeRun(runId, report) {
  const summary = summarizeChecks(report.checks);
  await systemPatrolDb.$executeRawUnsafe(
    `UPDATE "${RUN_TABLE}"
     SET "status" = 'completed',
         "summaryScore" = ?,
         "summaryStatus" = ?,
         "countsJson" = ?,
         "reportJson" = ?,
         "completedAt" = CURRENT_TIMESTAMP
     WHERE "id" = ?`,
    summary.score,
    summary.status,
    JSON.stringify(summary.counts),
    JSON.stringify({ ...report, summary }),
    runId
  );
  return { ...report, id: runId, summary };
}

async function failRun(runId, error) {
  await systemPatrolDb.$executeRawUnsafe(
    `UPDATE "${RUN_TABLE}"
     SET "status" = 'failed',
         "error" = ?,
         "completedAt" = CURRENT_TIMESTAMP
     WHERE "id" = ?`,
    error.message || String(error),
    runId
  );
}

function diskUsageFor(targetPath) {
  try {
    const output = execFileSync("df", ["-Pk", targetPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")
      .pop();
    const parts = output.trim().split(/\s+/);
    const usedPercent = Number(String(parts[4] || "0").replace("%", ""));
    return {
      filesystem: parts[0],
      sizeKb: Number(parts[1]),
      usedKb: Number(parts[2]),
      availableKb: Number(parts[3]),
      usedPercent,
      mount: parts[5],
    };
  } catch (error) {
    return { error: error.message };
  }
}

async function checkStorage() {
  const root = storageRoot();
  const checks = [];
  let writable = false;
  try {
    fs.mkdirSync(root, { recursive: true });
    const probe = path.join(root, ".system-patrol-write-test");
    fs.writeFileSync(probe, String(Date.now()));
    fs.unlinkSync(probe);
    writable = true;
  } catch {}

  const usage = diskUsageFor(root);
  const env = diagnosticSummary();
  const severity = !writable
    ? "critical"
    : usage.usedPercent >= 90
      ? "critical"
      : usage.usedPercent >= 80
        ? "warning"
        : "healthy";

  checks.push(
    checkResult({
      id: "storage.root",
      category: "storage",
      status: severity === "healthy" ? "healthy" : "attention",
      severity,
      summary: writable
        ? `Storage root is writable at ${root}.`
        : `Storage root is not writable at ${root}.`,
      evidence: {
        storageRoot: root,
        databasePath: databasePath(),
        authDatabasePath: authDatabasePath(),
        vectorRoot: env.vectorStore.root,
        disk: usage,
        legacyStorageDetected: env.legacyStorageDetected,
      },
      repairAction:
        severity === "critical"
          ? {
              id: repairId("storage.runbook", { root }),
              action: "storage.runbook",
              label: "Show storage reconnect runbook",
              risk: "manual_only",
            }
          : null,
    })
  );

  return checks;
}

async function checkMainDatabase() {
  try {
    const quickCheck =
      await systemPatrolDb.$queryRawUnsafe("PRAGMA quick_check");
    const tableCount = await systemPatrolDb.$queryRawUnsafe(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'"
    );
    return [
      checkResult({
        id: "database.sqlite",
        category: "database",
        status: "healthy",
        severity: "healthy",
        summary: "Main SQLite database is reachable and quick_check passed.",
        evidence: {
          path: databasePath(),
          quickCheck,
          tables: Number(tableCount?.[0]?.count || 0),
        },
      }),
    ];
  } catch (error) {
    return [
      checkResult({
        id: "database.sqlite",
        category: "database",
        status: "failed",
        severity: "critical",
        summary: "Main SQLite database is not healthy.",
        evidence: { path: databasePath(), error: error.message },
      }),
    ];
  }
}

async function withAuthDb(fn) {
  const authDb = new PrismaClient({
    datasources: { db: { url: authDatabaseUrl() } },
    log: ["error", "warn"],
  });
  try {
    return await fn(authDb);
  } finally {
    await authDb.$disconnect().catch(() => null);
  }
}

async function checkSharedAuth({ deep = false } = {}) {
  try {
    const summary = await withAuthDb((authDb) =>
      auditSharedAuthIdentity({
        envDb: systemPatrolDb,
        authDb,
        envName: appEnvironment(),
        dryRun: true,
        logger: { log: () => {}, warn: () => {} },
      })
    );
    const broken =
      summary.pendingFixes > 0 ||
      summary.linkedExisting > 0 ||
      summary.missingAuthRepaired > 0 ||
      summary.duplicates.length > 0;
    return [
      checkResult({
        id: "auth.shared_identity",
        category: "auth",
        status: broken ? "attention" : "healthy",
        severity: broken ? "warning" : "healthy",
        summary: broken
          ? "Shared auth identity audit found accounts needing repair."
          : "Shared auth identity links are valid.",
        evidence: {
          envName: summary.envName,
          totalUsers: summary.totalUsers,
          valid: summary.valid,
          pendingFixes: summary.pendingFixes,
          duplicates: summary.duplicates,
          sample:
            deep === true
              ? summary.results.filter((r) => r.action !== "valid").slice(0, 25)
              : [],
        },
        repairAction: broken
          ? {
              id: repairId("auth.fixSharedIdentity", {
                envName: summary.envName,
              }),
              action: "auth.fixSharedIdentity",
              label: "Relink or recreate shared auth identities",
              risk: "medium",
            }
          : null,
      }),
    ];
  } catch (error) {
    return [
      checkResult({
        id: "auth.shared_identity",
        category: "auth",
        status: "failed",
        severity: "critical",
        summary: "Shared auth database is not reachable.",
        evidence: {
          path: authDatabasePath(),
          urlConfigured: Boolean(process.env.AUTH_DATABASE_URL),
          error: error.message,
        },
      }),
    ];
  }
}

async function lanceTables() {
  if ((process.env.VECTOR_DB || "lancedb") !== "lancedb") {
    return { provider: process.env.VECTOR_DB, tables: [], skipped: true };
  }
  const { LanceDb } = require("../vectorDbProviders/lance");
  const vectorDb = new LanceDb();
  const { client } = await vectorDb.connect();
  const tables = await client.tableNames();
  const counts = {};
  for (const tableName of tables) {
    try {
      const table = await client.openTable(tableName);
      counts[tableName] = await table.countRows();
    } catch (error) {
      counts[tableName] = { error: error.message };
    }
  }
  return { provider: "lancedb", tables, counts };
}

async function checkVectorNamespaces({ deep = false } = {}) {
  try {
    const workspaces = await Workspace.where();
    const { provider, tables, counts, skipped } = await lanceTables();
    if (skipped) {
      return [
        checkResult({
          id: "vector.provider",
          category: "vector",
          status: "info",
          severity: "info",
          summary: `Vector provider is ${provider}; LanceDB namespace patrol was skipped.`,
          evidence: { provider },
        }),
      ];
    }

    const prefix = vectorNamespacePrefix();
    const legacyTables = tables.filter(
      (name) => UUID_RE.test(name) && !name.startsWith(prefix)
    );
    const namespaceIssues = [];
    for (const workspace of workspaces) {
      const expected = vectorNamespace(workspace.slug);
      const bare = workspace.slug;
      const expectedCount = counts[expected] || 0;
      const bareCount = counts[bare] || 0;
      const dbVectorCount = await systemPatrolDb.document_vectors.count({
        where: {
          docId: {
            in: (await Document.forWorkspace(workspace.id)).map(
              (doc) => doc.docId
            ),
          },
        },
      });
      if (!tables.includes(expected) && tables.includes(bare)) {
        namespaceIssues.push({
          workspaceId: workspace.id,
          slug: workspace.slug,
          expected,
          legacy: bare,
          legacyRows: bareCount,
          dbVectorCount,
        });
      } else if (dbVectorCount > 0 && expectedCount === 0) {
        namespaceIssues.push({
          workspaceId: workspace.id,
          slug: workspace.slug,
          expected,
          expectedRows: expectedCount,
          dbVectorCount,
          reason: "db_vectors_exist_but_lance_table_empty",
        });
      }
    }

    const hasIssues = namespaceIssues.length > 0;
    return [
      checkResult({
        id: "vector.lancedb_namespace",
        category: "vector",
        status: hasIssues ? "attention" : "healthy",
        severity: hasIssues ? "warning" : "healthy",
        summary: hasIssues
          ? "LanceDB namespace mismatch detected."
          : "LanceDB namespaces match the current environment prefix.",
        evidence: {
          provider,
          namespacePrefix: prefix,
          tableCount: tables.length,
          legacyTables,
          issues: deep ? namespaceIssues : namespaceIssues.slice(0, 10),
          counts: deep ? counts : undefined,
        },
        repairAction: hasIssues
          ? {
              id: repairId("vector.promoteLegacyNamespace", {
                prefix,
                slugs: namespaceIssues.map((issue) => issue.slug).sort(),
              }),
              action: "vector.promoteLegacyNamespace",
              label: "Promote legacy LanceDB tables to current namespace",
              risk: "high",
            }
          : null,
      }),
    ];
  } catch (error) {
    return [
      checkResult({
        id: "vector.lancedb_namespace",
        category: "vector",
        status: "failed",
        severity: "critical",
        summary: "Vector database namespace check failed.",
        evidence: { error: error.message },
      }),
    ];
  }
}

async function workspaceDocumentVectorIssues(
  workspaces,
  { deep = false } = {}
) {
  const summaries = [];
  const documentsRoot = storagePath("documents");
  for (const workspace of workspaces) {
    const docs = await Document.forWorkspace(workspace.id);
    const docIds = docs.map((doc) => doc.docId);
    const vectorRows = docIds.length
      ? await DocumentVectors.where({ docId: { in: docIds } })
      : [];
    const vectorDocIds = new Set(vectorRows.map((row) => row.docId));
    const missingVectors = docs.filter((doc) => !vectorDocIds.has(doc.docId));
    const missingFiles = docs.filter((doc) => {
      const normalized = path
        .normalize(String(doc.docpath || ""))
        .replace(/^(\.\.(\/|\\|$))+/, "")
        .trim();
      if (!normalized || ["..", ".", "/"].includes(normalized)) return true;
      const fullPath = path.resolve(documentsRoot, normalized);
      const relative = path.relative(documentsRoot, fullPath);
      if (relative.startsWith("../") || relative === "..") return true;
      return !fs.existsSync(fullPath);
    });
    const indexStatuses = await systemPatrolDb.documentIndexStatus.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { updatedAt: "desc" },
    });
    const stuckIndexStatuses = indexStatuses.filter((status) =>
      ["pending", "indexing"].includes(status.indexStatus)
    );
    if (
      missingVectors.length === 0 &&
      missingFiles.length === 0 &&
      stuckIndexStatuses.length === 0
    )
      continue;
    summaries.push({
      workspaceId: workspace.id,
      slug: workspace.slug,
      workspaceDocuments: docs.length,
      vectorRows: vectorRows.length,
      missingVectorDocuments: missingVectors.length,
      missingFiles: missingFiles.length,
      stuckIndexStatuses: stuckIndexStatuses.length,
      sample: deep
        ? missingVectors.slice(0, 25).map((doc) => ({
            docId: doc.docId,
            filename: doc.filename,
            docpath: doc.docpath,
          }))
        : [],
      fileSample: deep
        ? missingFiles.slice(0, 25).map((doc) => ({
            docId: doc.docId,
            filename: doc.filename,
            docpath: doc.docpath,
          }))
        : [],
      indexSample: deep
        ? stuckIndexStatuses.slice(0, 25).map((status) => ({
            docId: status.docId,
            filePath: status.filePath,
            indexStatus: status.indexStatus,
            updatedAt: status.updatedAt,
          }))
        : [],
    });
  }
  return summaries;
}

async function checkWorkspaceConsistency({ deep = false } = {}) {
  const workspaces = await Workspace.where();
  const issues = await workspaceDocumentVectorIssues(workspaces, { deep });
  return [
    checkResult({
      id: "workspace.document_vectors",
      category: "workspace",
      status: issues.length ? "attention" : "healthy",
      severity: issues.length ? "warning" : "healthy",
      summary: issues.length
        ? "Workspace document, file, or vector consistency issues were detected."
        : "Workspace document, file, and vector metadata is consistent.",
      evidence: {
        workspaceCount: workspaces.length,
        issues: deep ? issues : issues.slice(0, 10),
      },
      repairAction: issues.length
        ? {
            id: repairId("workspace.documentVectorRunbook", {
              slugs: issues.map((issue) => issue.slug).sort(),
            }),
            action: "workspace.documentVectorRunbook",
            label: "Show document/vector repair guidance",
            risk: "manual_only",
          }
        : null,
    }),
  ];
}

async function checkBackgroundWorkers() {
  const recentRuns = await systemPatrolDb
    .$queryRawUnsafe(
      `SELECT "mode", "status", "summaryStatus", "startedAt", "completedAt"
     FROM "${RUN_TABLE}"
     ORDER BY "startedAt" DESC
     LIMIT 5`
    )
    .catch(() => []);
  return [
    checkResult({
      id: "background.system_patrol",
      category: "background",
      status: "healthy",
      severity: "healthy",
      summary: "System patrol worker and API are available.",
      evidence: { recentRuns },
    }),
  ];
}

async function runSystemPatrol({
  mode = "light",
  trigger = "manual",
  triggeredBy = null,
} = {}) {
  const normalizedMode = mode === "deep" ? "deep" : "light";
  const runId = await createRun({ mode: normalizedMode, trigger, triggeredBy });
  try {
    const deep = normalizedMode === "deep";
    const checks = [
      ...(await checkStorage()),
      ...(await checkMainDatabase()),
      ...(await checkSharedAuth({ deep })),
      ...(await checkVectorNamespaces({ deep })),
      ...(deep ? await checkWorkspaceConsistency({ deep }) : []),
      ...(await checkBackgroundWorkers()),
    ];
    return await completeRun(runId, {
      mode: normalizedMode,
      trigger,
      generatedAt: nowIso(),
      environment: {
        appEnv: appEnvironment(),
        vectorNamespacePrefix: vectorNamespacePrefix(),
        storageRoot: storageRoot(),
      },
      checks,
    });
  } catch (error) {
    await failRun(runId, error);
    throw error;
  }
}

async function latestRun() {
  await ensurePatrolTables();
  const rows = await systemPatrolDb.$queryRawUnsafe(
    `SELECT * FROM "${RUN_TABLE}" ORDER BY "startedAt" DESC LIMIT 1`
  );
  return hydrateRun(rows?.[0] || null);
}

async function getRun(runId) {
  await ensurePatrolTables();
  const rows = await systemPatrolDb.$queryRawUnsafe(
    `SELECT * FROM "${RUN_TABLE}" WHERE "id" = ? LIMIT 1`,
    Number(runId)
  );
  return hydrateRun(rows?.[0] || null);
}

function hydrateRun(row) {
  if (!row) return null;
  return {
    ...row,
    counts: safeJsonParse(row.countsJson, {}),
    report: safeJsonParse(row.reportJson, {}),
  };
}

async function status() {
  const latest = await latestRun();
  return {
    success: true,
    latestRun: latest,
    environment: {
      appEnv: appEnvironment(),
      storageRoot: storageRoot(),
      databasePath: databasePath(),
      authDatabasePath: authDatabasePath(),
      vectorRoot: storagePath("lancedb"),
      namespacePrefix: vectorNamespacePrefix(),
    },
  };
}

async function findRepairInRuns(id) {
  await ensurePatrolTables();
  const rows = await systemPatrolDb.$queryRawUnsafe(
    `SELECT * FROM "${RUN_TABLE}" ORDER BY "startedAt" DESC LIMIT 25`
  );
  for (const row of rows) {
    const run = hydrateRun(row);
    const checks = run?.report?.checks || [];
    const check = checks.find((item) => item.repairAction?.id === id);
    if (check) return { run, check, repairAction: check.repairAction };
  }
  return null;
}

function storageRunbookPreview() {
  return {
    kind: "manual_runbook",
    title: "Storage reconnect runbook",
    operations: [
      "Confirm the data disk is mounted before starting the container.",
      "Confirm the Docker bind mount points /app/server/storage to the persistent data directory.",
      "Do not run destructive repairs while storageRoot is missing or read-only.",
    ],
  };
}

function documentVectorRunbookPreview() {
  return {
    kind: "manual_runbook",
    title: "Document/vector repair guidance",
    operations: [
      "Inspect missing document vector records by workspace.",
      "Prefer relinking metadata only when LanceDB rows exist.",
      "Re-embedding documents must be triggered explicitly outside automatic patrol repair.",
    ],
  };
}

async function vectorPromotePreview() {
  const { tables, counts } = await lanceTables();
  const prefix = vectorNamespacePrefix();
  const operations = [];
  for (const table of tables) {
    if (!UUID_RE.test(table) || table.startsWith(prefix)) continue;
    const target = `${prefix}${table}`;
    operations.push({
      type: "rename_lancedb_table",
      source: table,
      target,
      sourceRows: counts[table] || 0,
      targetExists: tables.includes(target),
    });
  }
  return {
    kind: "vector_namespace_migration",
    title: "Promote legacy LanceDB namespaces",
    operations,
    blocked: operations.some((op) => op.targetExists),
    backupRequired: true,
  };
}

async function authFixPreview() {
  const summary = await withAuthDb((authDb) =>
    auditSharedAuthIdentity({
      envDb: systemPatrolDb,
      authDb,
      envName: appEnvironment(),
      dryRun: true,
      logger: { log: () => {}, warn: () => {} },
    })
  );
  return {
    kind: "shared_auth_identity_repair",
    title: "Relink or recreate shared auth identities",
    summary: {
      totalUsers: summary.totalUsers,
      valid: summary.valid,
      pendingFixes: summary.pendingFixes,
      duplicates: summary.duplicates,
    },
    operations: summary.results.filter((result) => result.action !== "valid"),
    blocked: summary.duplicates.length > 0,
    backupRequired: true,
  };
}

async function previewRepair(repairIdValue) {
  const found = await findRepairInRuns(repairIdValue);
  if (!found) throw new Error("Repair action not found in recent patrol runs.");

  let preview;
  switch (found.repairAction.action) {
    case "storage.runbook":
      preview = storageRunbookPreview();
      break;
    case "workspace.documentVectorRunbook":
      preview = documentVectorRunbookPreview();
      break;
    case "vector.promoteLegacyNamespace":
      preview = await vectorPromotePreview();
      break;
    case "auth.fixSharedIdentity":
      preview = await authFixPreview();
      break;
    default:
      throw new Error(
        `Unsupported repair action: ${found.repairAction.action}`
      );
  }

  await systemPatrolDb.$executeRawUnsafe(
    `INSERT INTO "${REPAIR_TABLE}"
       ("repairId", "runId", "checkId", "action", "status", "previewJson", "updatedAt")
     VALUES (?, ?, ?, ?, 'previewed', ?, CURRENT_TIMESTAMP)
     ON CONFLICT("repairId") DO UPDATE SET
       "runId" = excluded."runId",
       "checkId" = excluded."checkId",
       "action" = excluded."action",
       "status" = 'previewed',
       "previewJson" = excluded."previewJson",
       "updatedAt" = CURRENT_TIMESTAMP`,
    repairIdValue,
    found.run.id,
    found.check.id,
    found.repairAction.action,
    JSON.stringify(preview)
  );

  return {
    success: true,
    repairId: repairIdValue,
    action: found.repairAction,
    preview,
  };
}

function backupDirFor(action) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = storagePath("backups", "system-patrol", `${stamp}-${action}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function copyIfExists(source, target) {
  if (!source || !fs.existsSync(source)) return false;
  fs.cpSync(source, target, { recursive: true });
  return true;
}

async function executeVectorPromote(preview) {
  if (preview.blocked) {
    throw new Error(
      "Target LanceDB namespace already exists; refusing to overwrite."
    );
  }
  const backupDir = backupDirFor("vector-namespace");
  copyIfExists(databasePath(), path.join(backupDir, "anythingllm.db"));

  const lancedbRoot = storagePath("lancedb");
  for (const operation of preview.operations) {
    const sourceDir = path.join(lancedbRoot, `${operation.source}.lance`);
    const targetDir = path.join(lancedbRoot, `${operation.target}.lance`);
    if (!fs.existsSync(sourceDir)) continue;
    copyIfExists(sourceDir, path.join(backupDir, `${operation.source}.lance`));
    if (fs.existsSync(targetDir)) {
      throw new Error(`Target namespace already exists: ${operation.target}`);
    }
    fs.renameSync(sourceDir, targetDir);
  }
  return {
    backupPath: backupDir,
    migrated: preview.operations.length,
    operations: preview.operations,
  };
}

async function executeAuthFix(preview) {
  if (preview.blocked) {
    throw new Error(
      "Duplicate authUserId values require manual cleanup first."
    );
  }
  const backupDir = backupDirFor("auth-identity");
  copyIfExists(databasePath(), path.join(backupDir, "anythingllm.db"));
  const authPath = authDatabasePath();
  if (authPath) copyIfExists(authPath, path.join(backupDir, "auth.db"));

  const summary = await withAuthDb((authDb) =>
    auditSharedAuthIdentity({
      envDb: systemPatrolDb,
      authDb,
      envName: appEnvironment(),
      dryRun: false,
      logger: { log: () => {}, warn: () => {} },
    })
  );
  return { backupPath: backupDir, summary };
}

async function confirmRepair(repairIdValue, { confirmedBy = null } = {}) {
  await ensurePatrolTables();
  const previewPayload = await previewRepair(repairIdValue);
  const { action, preview } = previewPayload;
  let result;

  switch (action.action) {
    case "storage.runbook":
    case "workspace.documentVectorRunbook":
      result = { manualOnly: true, message: "This repair is guidance-only." };
      break;
    case "vector.promoteLegacyNamespace":
      result = await executeVectorPromote(preview);
      break;
    case "auth.fixSharedIdentity":
      result = await executeAuthFix(preview);
      break;
    default:
      throw new Error(`Unsupported repair action: ${action.action}`);
  }

  await systemPatrolDb.$executeRawUnsafe(
    `UPDATE "${REPAIR_TABLE}"
     SET "status" = 'completed',
         "confirmedBy" = ?,
         "backupPath" = ?,
         "resultJson" = ?,
         "updatedAt" = CURRENT_TIMESTAMP
     WHERE "repairId" = ?`,
    confirmedBy || null,
    result.backupPath || null,
    JSON.stringify(result),
    repairIdValue
  );

  return { success: true, repairId: repairIdValue, action, result };
}

module.exports = {
  ensurePatrolTables,
  previewRepair,
  confirmRepair,
  runSystemPatrol,
  status,
  getRun,
};
