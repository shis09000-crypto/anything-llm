#!/usr/bin/env node
const path = require("path");
const fs = require("fs");
const { PrismaClient } = require("@prisma/client");

function parseArgs(argv = []) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function sqliteDatasourceUrl(dbPath) {
  const url = new URL(`file:${dbPath}`);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "10");
  return url.toString();
}

function safeJsonParse(input = "", fallback = {}) {
  try {
    return JSON.parse(input || "{}");
  } catch {
    return fallback;
  }
}

function shortHash(value = null) {
  if (!value) return null;
  return String(value).slice(0, 12);
}

function comparableMetrics(current = {}, previous = {}) {
  const currentDiagnostics = current?.promptCacheDiagnostics || {};
  const previousDiagnostics = previous?.promptCacheDiagnostics || {};
  if (
    currentDiagnostics.providerPath &&
    previousDiagnostics.providerPath &&
    currentDiagnostics.providerPath !== previousDiagnostics.providerPath
  )
    return false;
  if (current.model && previous.model && current.model !== previous.model)
    return false;
  return true;
}

function metricsFromChat(chat = {}) {
  const response = safeJsonParse(chat.response);
  const metrics = response?.metrics || null;
  const diagnostics = metrics?.promptCacheDiagnostics || null;
  if (!metrics || !diagnostics) return null;
  if (!diagnostics.providerPath && !diagnostics.stablePrefixFingerprint)
    return null;
  return metrics;
}

async function resolveThread(prisma, { workspaceSlug = null, thread = null }) {
  if (!thread) throw new Error("Missing --thread <threadSlugOrId>");
  if (/^\d+$/.test(String(thread))) {
    const found = await prisma.workspace_threads.findUnique({
      where: { id: Number(thread) },
    });
    if (!found) throw new Error(`Thread id ${thread} was not found`);
    return found;
  }

  let workspace = null;
  if (workspaceSlug) {
    workspace = await prisma.workspaces.findUnique({
      where: { slug: workspaceSlug },
    });
    if (!workspace) throw new Error(`Workspace ${workspaceSlug} was not found`);
  }

  const found = workspace
    ? await prisma.workspace_threads.findFirst({
        where: { slug: String(thread), workspace_id: workspace.id },
      })
    : await prisma.workspace_threads.findUnique({
        where: { slug: String(thread) },
      });
  if (!found) throw new Error(`Thread ${thread} was not found`);
  return found;
}

function reportRow(chat, metrics, diagnosis) {
  const diagnostics = metrics.promptCacheDiagnostics || {};
  const window = diagnostics.historyWindow || {};
  return {
    id: chat.id,
    include: chat.include,
    provider: metrics.provider || diagnostics.provider,
    model: metrics.model || diagnostics.model,
    hit: metrics.prompt_cache_hit_tokens ?? null,
    miss: metrics.prompt_cache_miss_tokens ?? null,
    rate:
      typeof metrics.prompt_cache_hit_rate === "number"
        ? Number(metrics.prompt_cache_hit_rate.toFixed(4))
        : null,
    reason: diagnosis.reason,
    path: diagnostics.providerPath || null,
    window:
      window.windowStartOrdinal && window.windowEndOrdinal
        ? `${window.windowStartOrdinal}-${window.windowEndOrdinal}`
        : null,
    stableChanged: diagnosis.stablePrefixChanged,
    toolChanged: diagnosis.toolShapeChanged,
    boundaryChanged: diagnosis.historyWindowBoundaryChanged,
    compactionChanged: diagnosis.compactionChanged,
    toolCount: diagnostics.toolCount ?? null,
    stableFp: shortHash(diagnostics.stablePrefixFingerprint),
    toolFp: shortHash(diagnostics.toolShapeFingerprint),
    compactionFp: shortHash(diagnostics.compactionFingerprint),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = String(args.env || process.env.APP_ENV || "development");
  if (!["development", "production"].includes(env))
    throw new Error("--env must be development or production");

  process.env.APP_ENV = env;
  process.env.NODE_ENV = env === "production" ? "production" : "development";

  const serverRoot = path.resolve(__dirname, "..");
  require("dotenv").config({
    path: path.join(
      serverRoot,
      env === "development" ? ".env.development" : ".env"
    ),
  });

  const { databasePath } = require("../utils/environment");
  const {
    deepSeekCacheDiagnosis,
    hasDeepSeekCacheDiagnostics,
  } = require("../utils/AiProviders/deepseek/promptCache");
  const dbPath = databasePath();
  if (!fs.existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);

  const prisma = new PrismaClient({
    datasources: { db: { url: sqliteDatasourceUrl(dbPath) } },
    log: ["error"],
  });

  try {
    const limit = Number(args.limit || 20);
    const thread = await resolveThread(prisma, {
      workspaceSlug: args.workspace || null,
      thread: args.thread,
    });
    const chats = await prisma.workspace_chats.findMany({
      where: { thread_id: thread.id },
      orderBy: { id: "desc" },
      take: Math.max(limit * 5, limit),
    });

    const rows = [];
    let previousMetrics = null;
    for (const chat of [...chats].reverse()) {
      const metrics = metricsFromChat(chat);
      if (!hasDeepSeekCacheDiagnostics(metrics)) continue;
      const comparablePrevious =
        previousMetrics && comparableMetrics(metrics, previousMetrics)
          ? previousMetrics
          : null;
      const diagnosis =
        metrics.cacheDiagnosis ||
        deepSeekCacheDiagnosis({
          metrics,
          previousMetrics: comparablePrevious,
        });
      rows.push(reportRow(chat, metrics, diagnosis));
      previousMetrics = metrics;
    }

    const limitedRows = rows.slice(-limit);
    if (args.json) console.log(JSON.stringify(limitedRows, null, 2));
    else {
      console.log(
        `[DeepSeekCacheDiagnosis] env=${env} db=${dbPath} thread=${thread.slug} rows=${limitedRows.length}`
      );
      console.table(limitedRows);
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((error) => {
  console.error("[DeepSeekCacheDiagnosis] failed", error.message);
  process.exit(1);
});
