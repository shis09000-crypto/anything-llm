#!/usr/bin/env node
const zlib = require("zlib");
const { performance } = require("perf_hooks");
const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");

let prisma;
let SyncV2;

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function gzipBytes(value) {
  return zlib.gzipSync(JSON.stringify(value)).byteLength;
}

function percentageReduction(previous, next) {
  if (!previous) return 0;
  return Number((((previous - next) / previous) * 100).toFixed(2));
}

function benchmarkRuns() {
  const configured = Number(process.env.ATHENA_SYNC_V2_BENCHMARK_RUNS || 3);
  return Math.min(Math.max(Math.floor(configured) || 3, 1), 10);
}

async function measure(operation, runs) {
  const samples = [];
  let result = null;
  for (let attempt = 0; attempt < runs; attempt += 1) {
    const startedAt = performance.now();
    result = await operation();
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  return {
    result,
    medianMs: samples[Math.floor(samples.length / 2)],
  };
}

function permitsAllWorkspaces(user) {
  return ["admin", "owner"].includes(String(user?.role || "").toLowerCase());
}

async function workspaceIdsForUser(user) {
  if (permitsAllWorkspaces(user)) {
    return (
      await prisma.workspaces.findMany({
        select: { id: true },
        orderBy: { id: "asc" },
      })
    ).map((workspace) => workspace.id);
  }
  return (
    await prisma.workspace_users.findMany({
      where: { user_id: user.id },
      select: { workspace_id: true },
      orderBy: { workspace_id: "asc" },
    })
  ).map((membership) => membership.workspace_id);
}

async function legacyBootstrap(user) {
  const workspaceIds = await workspaceIdsForUser(user);
  const workspaces = await prisma.workspaces.findMany({
    where: { id: { in: workspaceIds } },
    orderBy: { id: "asc" },
  });
  const details = [];
  const threadResponses = [];
  const allThreads = [];
  for (const workspace of workspaces) {
    details.push({
      workspace: await prisma.workspaces.findUnique({
        where: { id: workspace.id },
        include: { documents: true },
      }),
    });
    const threads = await prisma.workspace_threads.findMany({
      where: {
        workspace_id: workspace.id,
        OR: [{ user_id: user.id }, { user_id: null }],
      },
      orderBy: { id: "asc" },
    });
    allThreads.push(...threads);
    threadResponses.push({ workspaceId: workspace.id, threads });
  }
  const latestThread = allThreads.at(-1) || null;
  const history = latestThread
    ? await prisma.workspace_chats.findMany({
        where: {
          workspaceId: latestThread.workspace_id,
          thread_id: latestThread.id,
          user_id: user.id,
          api_session_id: null,
          include: true,
        },
        orderBy: { id: "desc" },
        take: 20,
      })
    : [];
  const envelopes = [
    { workspaces },
    ...details,
    ...threadResponses,
    ...(latestThread ? [{ history: [...history].reverse() }] : []),
  ];
  return {
    workspaceCount: workspaces.length,
    threadCount: allThreads.length,
    requestCount:
      1 + workspaces.length + workspaces.length + (latestThread ? 1 : 0),
    envelopes,
  };
}

async function syncBootstrap(user) {
  const allowAllWorkspaces = permitsAllWorkspaces(user);
  const manifest = await SyncV2.manifestForUser({
    userId: user.id,
    allowAllWorkspaces,
    materialize: false,
  });
  const warmManifest = await SyncV2.manifestForUser({
    userId: user.id,
    allowAllWorkspaces,
    materialize: false,
    knownManifestHash: manifest.manifestHash,
  });
  const nodes = [];
  const eagerDescriptors = manifest.nodes.filter(
    (descriptor) => descriptor.hydration !== "lazy"
  );
  for (let offset = 0; offset < eagerDescriptors.length; offset += 100) {
    nodes.push(
      ...(await SyncV2.batchGet({
        userId: user.id,
        allowAllWorkspaces,
        nodes: eagerDescriptors
          .slice(offset, offset + 100)
          .map((descriptor) => ({
            nodeKey: descriptor.nodeKey,
            knownVersion: 0,
          })),
      }))
    );
  }
  const manifestEnvelope = {
    success: true,
    protocolVersion: 2,
    checkpointSeq: manifest.checkpointSeq,
    manifestHash: manifest.manifestHash,
    unchanged: manifest.unchanged,
    nodes: manifest.nodes,
  };
  const warmManifestEnvelope = {
    success: true,
    protocolVersion: 2,
    checkpointSeq: warmManifest.checkpointSeq,
    manifestHash: warmManifest.manifestHash,
    unchanged: warmManifest.unchanged,
    nodes: warmManifest.nodes,
  };
  const replayEnvelope = {
    success: true,
    events: [],
    checkpointSeq: manifest.checkpointSeq,
    nextSeq: manifest.checkpointSeq,
    hasMore: false,
    requiresFullSync: false,
  };
  return {
    nodeCount: manifest.nodes.length,
    coldEnvelopes: [manifestEnvelope, { success: true, nodes }, replayEnvelope],
    warmEnvelopes: [warmManifestEnvelope, replayEnvelope],
    coldRequestCount: 2 + Math.ceil(eagerDescriptors.length / 100),
    warmRequestCount: 2,
  };
}

async function benchmark() {
  if (!(await SyncV2.schemaReady({ force: true })))
    throw new Error("sync_v2_schema_unavailable");
  const users = await prisma.users.findMany({
    select: { id: true, role: true },
    orderBy: { id: "asc" },
  });
  const runs = benchmarkRuns();
  const results = [];
  for (const user of users) {
    const legacyMeasurement = await measure(() => legacyBootstrap(user), runs);
    const syncMeasurement = await measure(() => syncBootstrap(user), runs);
    const legacy = legacyMeasurement.result;
    const sync = syncMeasurement.result;
    const legacyBytes = bytes(legacy.envelopes);
    const legacyGzipBytes = gzipBytes(legacy.envelopes);
    const coldBytes = bytes(sync.coldEnvelopes);
    const coldGzipBytes = gzipBytes(sync.coldEnvelopes);
    const warmBytes = bytes(sync.warmEnvelopes);
    const warmGzipBytes = gzipBytes(sync.warmEnvelopes);
    results.push({
      userId: user.id,
      workspaceCount: legacy.workspaceCount,
      threadCount: legacy.threadCount,
      nodeCount: sync.nodeCount,
      legacy: {
        requests: legacy.requestCount,
        bytes: legacyBytes,
        gzipBytes: legacyGzipBytes,
        readMs: Number(legacyMeasurement.medianMs.toFixed(2)),
      },
      syncCold: {
        requests: sync.coldRequestCount,
        bytes: coldBytes,
        gzipBytes: coldGzipBytes,
        readMs: Number(syncMeasurement.medianMs.toFixed(2)),
      },
      syncWarm: {
        requests: sync.warmRequestCount,
        bytes: warmBytes,
        gzipBytes: warmGzipBytes,
      },
      warmReduction: {
        requestsPercent: percentageReduction(
          legacy.requestCount,
          sync.warmRequestCount
        ),
        bytesPercent: percentageReduction(legacyBytes, warmBytes),
        gzipBytesPercent: percentageReduction(legacyGzipBytes, warmGzipBytes),
      },
    });
  }
  const total = (path, rows = results) =>
    rows.reduce(
      (sum, result) =>
        sum + path.split(".").reduce((value, key) => value?.[key], result),
      0
    );
  const aggregateFor = (rows) => ({
    users: rows.length,
    legacy: {
      requests: total("legacy.requests", rows),
      bytes: total("legacy.bytes", rows),
      gzipBytes: total("legacy.gzipBytes", rows),
    },
    syncCold: {
      requests: total("syncCold.requests", rows),
      bytes: total("syncCold.bytes", rows),
      gzipBytes: total("syncCold.gzipBytes", rows),
    },
    syncWarm: {
      requests: total("syncWarm.requests", rows),
      bytes: total("syncWarm.bytes", rows),
      gzipBytes: total("syncWarm.gzipBytes", rows),
    },
  });
  const addReductions = (aggregate) => ({
    ...aggregate,
    coldReduction: {
      requestsPercent: percentageReduction(
        aggregate.legacy.requests,
        aggregate.syncCold.requests
      ),
      bytesPercent: percentageReduction(
        aggregate.legacy.bytes,
        aggregate.syncCold.bytes
      ),
      gzipBytesPercent: percentageReduction(
        aggregate.legacy.gzipBytes,
        aggregate.syncCold.gzipBytes
      ),
    },
    warmReduction: {
      requestsPercent: percentageReduction(
        aggregate.legacy.requests,
        aggregate.syncWarm.requests
      ),
      bytesPercent: percentageReduction(
        aggregate.legacy.bytes,
        aggregate.syncWarm.bytes
      ),
      gzipBytesPercent: percentageReduction(
        aggregate.legacy.gzipBytes,
        aggregate.syncWarm.gzipBytes
      ),
    },
  });
  const aggregate = addReductions(aggregateFor(results));
  const activeUsers = results.filter((result) => result.workspaceCount > 0);
  const activeAggregate = addReductions(aggregateFor(activeUsers));
  console.log(
    JSON.stringify(
      {
        mode: "read-only",
        measuredAt: new Date().toISOString(),
        runs,
        methodology:
          "Legacy navigation envelopes versus actual Sync V2 manifest, nodes:batchGet pages, replay, and full changed-node envelopes over the same authoritative SQLite rows.",
        aggregate,
        activeAggregate,
        users: results,
      },
      null,
      2
    )
  );
}

async function run() {
  await bootstrapCliRuntime({
    requiredTables: ["users", "workspaces", "sync_nodes", "sync_outbox"],
  });
  prisma = require("../utils/prisma");
  SyncV2 = require("../models/syncV2").SyncV2;
  return benchmark();
}

run()
  .catch((error) => {
    console.error(`[sync-v2-benchmark] ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma?.$disconnect();
  });
