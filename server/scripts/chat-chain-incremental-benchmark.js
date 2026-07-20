#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { performance } = require("perf_hooks");
const { spawnSync } = require("child_process");
const dotenv = require("dotenv");

const serverRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(serverRoot, ".env.development") });
const sourceDatabasePath = path.resolve(
  process.env.ATHENA_CHAT_CHAIN_BENCHMARK_SOURCE_DB ||
    path.join(serverRoot, "storage", "development", "anythingllm.db")
);

const temporaryBase = fs.mkdtempSync(
  path.join(os.tmpdir(), "athena-chat-chain-benchmark-")
);
const databaseDirectory = path.join(temporaryBase, "development");
const databasePath = path.join(databaseDirectory, "anythingllm.db");
fs.mkdirSync(databaseDirectory, { recursive: true });

process.env.APP_ENV = "development";
process.env.NODE_ENV = "development";
process.env.STORAGE_DIR = temporaryBase;
delete process.env.ANYTHINGLLM_ENV_STORAGE_APPLIED;
process.env.DATABASE_URL = `file:${databasePath}`;
process.env.CHAT_HISTORY_INCREMENTAL_CHAIN_APPEND = "true";

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1)
  );
  return sorted[index] || 0;
}

function rounded(value) {
  return Number(Number(value || 0).toFixed(3));
}

async function insertChatRows(prisma, rows) {
  await prisma.$transaction(async (tx) => {
    for (let index = 0; index < rows.length; index += 100) {
      const chunk = rows.slice(index, index + 100);
      const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)");
      const values = chunk.flatMap((row) => [
        row.public_id,
        row.workspaceId,
        row.prompt,
        row.response,
        row.include ? 1 : 0,
        row.user_id,
        row.thread_id,
        row.api_session_id,
      ]);
      await tx.$executeRawUnsafe(
        `INSERT INTO "workspace_chats" ("public_id", "workspaceId", "prompt", "response", "include", "user_id", "thread_id", "api_session_id") VALUES ${placeholders.join(", ")}`,
        ...values
      );
    }
  });
}

function snapshotTemporaryDatabase() {
  if (!fs.existsSync(sourceDatabasePath)) {
    throw new Error(`source_database_missing: ${sourceDatabasePath}`);
  }
  const escapedTarget = databasePath.replaceAll("'", "''");
  const result = spawnSync(
    "sqlite3",
    [sourceDatabasePath, `.backup '${escapedTarget}'`],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(
      `temporary_database_snapshot_failed: ${result.stderr || result.stdout}`
    );
  }
}

async function benchmark() {
  snapshotTemporaryDatabase();
  const prisma = require("../utils/prisma");
  const {
    appendChatCryptoMetadataForRows,
    auditWorkspaceChatSerialIntegrity,
    chatChainRuntimeMetrics,
    encryptSerialChatField,
    rebuildChatCryptoChainForScope,
    resetChatChainRuntimeMetrics,
  } = require("../utils/security/chatHistorySerialEncryption");

  const historySizes = [10, 100, 1_000];
  const sampleCount = 120;
  const warmupCount = 30;
  const replicateCount = 5;
  const benchmarkCases = [];

  try {
    for (const historySize of historySizes) {
      for (let replicate = 0; replicate < replicateCount; replicate += 1) {
        const scope = {
          workspaceId: 90_000 + historySize * 10 + replicate,
          userId: null,
          threadId: null,
          apiSessionId: `benchmark-${historySize}-${replicate}`,
        };
        const prompt = await encryptSerialChatField(
          `prompt-${historySize}-${replicate}`,
          scope,
          prisma
        );
        const response = await encryptSerialChatField(
          `response-${historySize}-${replicate}`,
          scope,
          prisma
        );
        const row = (index) => ({
          public_id: `benchmark-${historySize}-${replicate}-${index}`,
          workspaceId: scope.workspaceId,
          prompt,
          response,
          include: true,
          user_id: null,
          thread_id: null,
          api_session_id: scope.apiSessionId,
        });

        await insertChatRows(
          prisma,
          Array.from({ length: historySize }, (_, index) => row(index))
        );
        await rebuildChatCryptoChainForScope(scope, { client: prisma });
        await insertChatRows(
          prisma,
          Array.from({ length: sampleCount + warmupCount }, (_, index) =>
            row(historySize + index)
          )
        );
        const appendRows = await prisma.workspace_chats.findMany({
          where: {
            workspaceId: scope.workspaceId,
            user_id: null,
            thread_id: null,
            api_session_id: scope.apiSessionId,
          },
          orderBy: { id: "asc" },
          skip: historySize,
        });
        benchmarkCases.push({
          historySize,
          replicate,
          scope,
          appendRows,
          durations: [],
        });
      }
    }

    async function appendMeasured(benchmarkCase, chat, recordDuration) {
      const startedAt = performance.now();
      const appended = await appendChatCryptoMetadataForRows(
        [chat],
        benchmarkCase.scope,
        { client: prisma }
      );
      const duration = performance.now() - startedAt;
      if (recordDuration) benchmarkCase.durations.push(duration);
      if (appended.fallback || appended.rebuilt || appended.appended !== 1) {
        throw new Error(
          `incremental_append_fallback_at_history_${benchmarkCase.historySize}`
        );
      }
    }

    // Warm every isolated replicate before recording sub-millisecond samples.
    // Rotate the case order on every sample so scheduler/CPU drift is spread
    // across history sizes and replicates instead of biasing one case.
    for (let index = 0; index < warmupCount; index += 1) {
      for (const benchmarkCase of benchmarkCases) {
        await appendMeasured(
          benchmarkCase,
          benchmarkCase.appendRows[index],
          false
        );
      }
    }
    resetChatChainRuntimeMetrics();
    for (let index = 0; index < sampleCount; index += 1) {
      const rotation = index % benchmarkCases.length;
      const orderedCases = [
        ...benchmarkCases.slice(rotation),
        ...benchmarkCases.slice(0, rotation),
      ];
      for (const benchmarkCase of orderedCases) {
        await appendMeasured(
          benchmarkCase,
          benchmarkCase.appendRows[warmupCount + index],
          true
        );
      }
    }

    const metrics = chatChainRuntimeMetrics();
    const replicateMeasurements = benchmarkCases.map((benchmarkCase) => ({
      ...benchmarkCase,
      p95RawMs: percentile(benchmarkCase.durations, 0.95),
    }));
    const measurements = historySizes.map((historySize) => {
      const replicates = replicateMeasurements.filter(
        (measurement) => measurement.historySize === historySize
      );
      const durations = replicates.flatMap(
        (measurement) => measurement.durations
      );
      return {
        historySize,
        durations,
        replicateP95RawMs: replicates.map(
          (measurement) => measurement.p95RawMs
        ),
        p95RawMs: percentile(
          replicates.map((measurement) => measurement.p95RawMs),
          0.5
        ),
      };
    });
    const results = measurements.map((measurement) => ({
      historySize: measurement.historySize,
      samples: measurement.durations.length,
      replicates: replicateCount,
      samplesPerReplicate: sampleCount,
      p50Ms: rounded(percentile(measurement.durations, 0.5)),
      p95Ms: rounded(measurement.p95RawMs),
      replicateP95Ms: measurement.replicateP95RawMs.map(rounded),
      meanMs: rounded(
        measurement.durations.reduce((total, duration) => total + duration, 0) /
          measurement.durations.length
      ),
      incrementalAppends: measurement.durations.length,
      rebuildFallbacks: 0,
      fullRebuilds: 0,
    }));

    const integrity = await auditWorkspaceChatSerialIntegrity({
      client: prisma,
    });
    const baseline = measurements.find(
      (measurement) => measurement.historySize === 10
    );
    const longest = measurements.find(
      (measurement) => measurement.historySize === 1_000
    );
    const p95GrowthPercent = rounded(
      ((longest.p95RawMs - baseline.p95RawMs) / baseline.p95RawMs) * 100
    );
    const success =
      metrics.chat_chain_incremental_appends ===
        sampleCount * replicateCount * historySizes.length &&
      metrics.chat_chain_rebuild_fallbacks === 0 &&
      metrics.chat_chain_full_rebuilds === 0 &&
      integrity.chainInvalid === 0 &&
      integrity.metadataMissing === 0 &&
      p95GrowthPercent <= 20;

    console.log(
      JSON.stringify(
        {
          success,
          isolatedTemporaryDatabase: true,
          interleavedSampling: true,
          historySizes,
          sampleCount,
          warmupCount,
          replicateCount,
          robustP95Estimator: "median_of_isolated_replicate_p95",
          results,
          p95GrowthPercent,
          acceptanceLimitPercent: 20,
          integrity: {
            chats: integrity.total,
            metadata: integrity.metadataTotal,
            metadataMissing: integrity.metadataMissing,
            chainInvalid: integrity.chainInvalid,
          },
        },
        null,
        2
      )
    );
    if (!success) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

benchmark()
  .catch((error) => {
    console.error(`[chat-chain-incremental-benchmark] ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(temporaryBase, { recursive: true, force: true });
  });
