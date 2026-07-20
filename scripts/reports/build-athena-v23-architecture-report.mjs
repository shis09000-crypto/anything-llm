#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const generatedAt = "2026-07-20T08:00:00+08:00";
const outputDir = path.resolve("output/pdf");
fs.mkdirSync(outputDir, { recursive: true });

const evidence = {
  release: "v2.3",
  generatedAt,
  environment: "development",
  verificationBoundary:
    "Real local SQLite/local content store/memory transport runtime; PostgreSQL/NATS/S3 verified through schemas, adapters and fault tests, not an external multi-node cutover.",
  landscape: {
    sourceFilesReviewed: 3199,
    frontendFiles: 1318,
    serverFiles: 1284,
    collectorFiles: 79,
    iosFiles: 111,
    desktopFiles: 17,
    serverEndpoints: 73,
    serverModels: 60,
    serverRepositories: 58,
    prismaModels: 136,
    postgresqlModels: 136,
    prismaMigrations: 102,
    ciWorkflows: 11,
    iosSwiftFiles: 73,
    reactFiles: 509,
    llmProviderDirectories: 37,
    vectorProviderDirectories: 10,
    agentPluginDirectories: 12,
  },
  realData: {
    databaseBytesBefore: 1007104000,
    databaseBytesAfter: 84914176,
    databaseReductionPct: 91.57,
    users: 4,
    workspaces: 6,
    threads: 72,
    chats: 1038,
    documents: 66,
    contentObjects: 7,
    attachmentRefs: 8,
    objectPlaintextBytes: 17292002,
    payloadV1: 204,
    payloadV2: 834,
  },
  sync: {
    nodes: 263,
    projectionsChecked: 186,
    tombstones: 2,
    inaccessibleNodes: 0,
    missingPayloads: 0,
    hashMismatches: 0,
    projectionConflicts: 0,
    latestSeq: 704,
    clientCursors: 3,
    maxCursorLag: 696,
    pendingOutbox: 0,
    deadLetterOutbox: 0,
    enabled: false,
  },
  performance: {
    warmRequestsReductionPct: 72.41,
    warmPayloadReductionPct: 99.47,
    warmGzipReductionPct: 97.48,
    activeWarmRequestsReductionPct: 85.19,
    activeWarmPayloadReductionPct: 99.73,
    activeColdPayloadReductionPct: 57.21,
    webEntryRawBytes: 825984,
    webEntryGzipBytes: 234701,
    chatAppendP95Ms: {
      history10: 0.248,
      history100: 0.238,
      history1000: 0.278,
    },
    chatAppendGrowthPct: 12.23,
  },
  quality: {
    backendSuites: 255,
    backendTests: 1350,
    frontendNodeTests: 396,
    iosTests: 99,
    desktopTests: 5,
    moduleFiles: 3423,
    moduleImports: 11266,
    moduleBoundaryFindings: 0,
    governedGodFilesBeforeV23: 8,
    governedGodFilesAfterV23: 7,
    fakeHealthyDatabaseFallbacksClosed: 146,
    remainingGovernedNonDatabaseFallbacks: 19,
  },
};

const evidencePath = path.join(
  outputDir,
  "athena-v2.3-architecture-evidence.json"
);
fs.writeFileSync(
  evidencePath,
  `${JSON.stringify(evidence, null, 2)}\n`,
  "utf8"
);

const source = (id, label, sourcePath, description, sql = null) => ({
  id,
  label,
  path: sourcePath,
  query: {
    engine: sql ? "sqlite" : "repository-review",
    language: sql ? "sql" : "json",
    ...(sql ? { sql } : {}),
    description,
    executed_at: generatedAt,
    filters: [
      "Development authority selected through APP_ENV",
      "Runtime data and secrets excluded from the report payload",
      "External distributed infrastructure not claimed as production evidence",
    ],
  },
});

const sources = [
  source(
    "release_evidence",
    "Athena v2.3 verified evidence snapshot",
    "output/pdf/athena-v2.3-architecture-evidence.json",
    "Reviewed repository inventory, real development database metrics, Sync V2 audit and release-gate totals.",
    `SELECT
       (SELECT COUNT(*) FROM "workspace_chats") AS chat_rows,
       (SELECT COUNT(*) FROM "sync_nodes") AS sync_nodes,
       (SELECT COUNT(*) FROM "sync_outbox") AS sync_events,
       (SELECT COUNT(*) FROM "content_objects" WHERE "status" = 'ready') AS ready_content_objects`
  ),
  source(
    "architecture_report",
    "Distributed architecture upgrade report",
    "docs/athena-distributed-architecture-upgrade-final-report-2026-07-20.md",
    "Architecture boundaries, data flow, performance baselines and rollout constraints."
  ),
  source(
    "defect_ledger",
    "Distributed architecture defect ledger",
    "docs/athena-distributed-architecture-upgrade-defect-ledger-2026-07-20.md",
    "Defect discovery, closure and final-gate evidence for the architecture program."
  ),
  source(
    "sync_design",
    "Sync V2 implementation contract",
    "docs/sync-v2-implementation.md",
    "State-tree protocol, event cursor, projection, cache and compatibility contracts."
  ),
  source(
    "codebase",
    "Athena source tree and runtime configuration",
    "package.json",
    "Runtime technologies, build boundaries and module ownership reviewed from the repository."
  ),
];

const esc = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function diagram(title, groups, arrows = [], height = 720) {
  const boxes = groups
    .map((group) => {
      const lines = group.lines || [];
      const lineSvg = lines
        .map(
          (line, index) =>
            `<text x="${group.x + 18}" y="${group.y + 57 + index * 22}" font-size="14" fill="#334155">${esc(line)}</text>`
        )
        .join("");
      return `<g><rect x="${group.x}" y="${group.y}" width="${group.w}" height="${group.h}" rx="16" fill="${group.fill || "#f8fafc"}" stroke="${group.stroke || "#94a3b8"}" stroke-width="2"/><text x="${group.x + 18}" y="${group.y + 30}" font-size="17" font-weight="700" fill="#0f172a">${esc(group.title)}</text>${lineSvg}</g>`;
    })
    .join("");
  const paths = arrows
    .map(
      (arrow) =>
        `<path d="M ${arrow.x1} ${arrow.y1} L ${arrow.x2} ${arrow.y2}" stroke="#475569" stroke-width="2" fill="none" marker-end="url(#arrow)"/><text x="${(arrow.x1 + arrow.x2) / 2 + (arrow.dx || 0)}" y="${(arrow.y1 + arrow.y2) / 2 + (arrow.dy || -7)}" text-anchor="middle" font-size="12" fill="#475569">${esc(arrow.label || "")}</text>`
    )
    .join("");
  return `<section style="width:100%;overflow:hidden;border:1px solid #dbe3ee;border-radius:18px;background:#fff;padding:18px;box-sizing:border-box"><h3 style="margin:0 0 12px;font:700 20px system-ui;color:#0f172a">${esc(title)}</h3><svg viewBox="0 0 1200 ${height}" width="100%" role="img" aria-label="${esc(title)}" style="display:block"><defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#475569"/></marker></defs>${paths}${boxes}</svg></section>`;
}

const landscapeDiagram = diagram(
  "Athena System Landscape Map",
  [
    {
      x: 30,
      y: 30,
      w: 1140,
      h: 62,
      title: "用户层 / User",
      lines: ["个人用户 · 企业成员 · 管理员 · Agent 操作者"],
      fill: "#eff6ff",
      stroke: "#3b82f6",
    },
    {
      x: 30,
      y: 115,
      w: 1140,
      h: 72,
      title: "客户端层 / Clients",
      lines: [
        "Web React · iOS/iPadOS SwiftUI · Electron Windows/macOS · Desktop offline",
      ],
      fill: "#eef2ff",
      stroke: "#6366f1",
    },
    {
      x: 30,
      y: 210,
      w: 1140,
      h: 84,
      title: "应用服务层 / Application Services",
      lines: [
        "REST · Chat SSE · Agent/Sync WebSocket · Session/AuthZ · Workspace/Chat/Reader APIs",
      ],
      fill: "#f0fdfa",
      stroke: "#0f766e",
    },
    {
      x: 30,
      y: 317,
      w: 1140,
      h: 84,
      title: "AI Orchestration Layer",
      lines: [
        "ModelExecutionContext · provider routing · Agent Registry · tools · budgets · eval contracts",
      ],
      fill: "#fdf4ff",
      stroke: "#a21caf",
    },
    {
      x: 30,
      y: 424,
      w: 550,
      h: 94,
      title: "Knowledge Layer",
      lines: [
        "Collector / Reader · documents · embeddings",
        "vector providers · knowledge graph · search",
      ],
      fill: "#fff7ed",
      stroke: "#ea580c",
    },
    {
      x: 620,
      y: 424,
      w: 550,
      h: 94,
      title: "Memory Layer",
      lines: [
        "recent/working context · compaction",
        "user memory · project memory · persona",
      ],
      fill: "#fefce8",
      stroke: "#ca8a04",
    },
    {
      x: 30,
      y: 541,
      w: 1140,
      h: 84,
      title: "Data Layer",
      lines: [
        "Domain tables · Auth DB · Content Objects · vector DB · graph · Sync nodes/outbox/cursors",
      ],
      fill: "#f8fafc",
      stroke: "#475569",
    },
    {
      x: 30,
      y: 648,
      w: 1140,
      h: 74,
      title: "Infrastructure Layer",
      lines: [
        "SQLite/local/memory active · PostgreSQL/NATS/S3 adapters · Runtime Coordinator · OTel/Prometheus/Grafana/Tempo/Loki",
      ],
      fill: "#f1f5f9",
      stroke: "#334155",
    },
  ],
  [
    { x1: 600, y1: 92, x2: 600, y2: 115 },
    { x1: 600, y1: 187, x2: 600, y2: 210 },
    { x1: 600, y1: 294, x2: 600, y2: 317 },
    { x1: 600, y1: 401, x2: 600, y2: 424 },
    { x1: 300, y1: 518, x2: 300, y2: 541 },
    { x1: 900, y1: 518, x2: 900, y2: 541 },
    { x1: 600, y1: 625, x2: 600, y2: 648 },
  ],
  750
);

const topologyDiagram = diagram(
  "Complete Architecture Diagram & Topology",
  [
    {
      x: 30,
      y: 35,
      w: 250,
      h: 118,
      title: "Web / iOS / Desktop",
      lines: ["encrypted cache", "mutation queue", "cursor + projections"],
      fill: "#eef2ff",
      stroke: "#6366f1",
    },
    {
      x: 335,
      y: 35,
      w: 250,
      h: 118,
      title: "Zero-Trust Edge",
      lines: [
        "body policy + signature",
        "Session V2",
        "resource/capability authz",
      ],
      fill: "#eff6ff",
      stroke: "#2563eb",
    },
    {
      x: 640,
      y: 35,
      w: 250,
      h: 118,
      title: "Domain APIs",
      lines: [
        "REST / SSE / WS",
        "Workspace / Chat / Reader",
        "repository boundaries",
      ],
      fill: "#ecfdf5",
      stroke: "#059669",
    },
    {
      x: 945,
      y: 35,
      w: 225,
      h: 118,
      title: "AI Runtime",
      lines: ["providers + tools", "budget / usage", "Agent / cognition"],
      fill: "#fdf4ff",
      stroke: "#a21caf",
    },
    {
      x: 30,
      y: 235,
      w: 260,
      h: 140,
      title: "Domain Authority",
      lines: [
        "Main DB + Auth DB",
        "Workspace / Chat / Memory",
        "append-only event domains",
      ],
      fill: "#f8fafc",
      stroke: "#475569",
    },
    {
      x: 330,
      y: 235,
      w: 260,
      h: 140,
      title: "Content Plane",
      lines: [
        "staging / checksum",
        "per-object AES-GCM",
        "Local active / S3 ready",
      ],
      fill: "#fff7ed",
      stroke: "#ea580c",
    },
    {
      x: 630,
      y: 235,
      w: 260,
      h: 140,
      title: "Sync Control Plane",
      lines: [
        "version + hash + cursor",
        "Outbox + receipt",
        "manifest / batchGet / repair",
      ],
      fill: "#f0fdfa",
      stroke: "#0f766e",
    },
    {
      x: 930,
      y: 235,
      w: 240,
      h: 140,
      title: "Delivery Plane",
      lines: ["memory / NATS ready", "WS + SSE", "APNs/Web Push wakeup"],
      fill: "#fefce8",
      stroke: "#ca8a04",
    },
    {
      x: 30,
      y: 465,
      w: 360,
      h: 135,
      title: "Knowledge & Retrieval",
      lines: [
        "Collector isolation · Reader workers",
        "10 vector providers · knowledge graph",
        "metadata/index/parse cursors",
      ],
      fill: "#fff7ed",
      stroke: "#c2410c",
    },
    {
      x: 420,
      y: 465,
      w: 360,
      h: 135,
      title: "Memory & Personalization",
      lines: [
        "short/working/long-term memory",
        "profile/persona/project context",
        "compaction and structured memory",
      ],
      fill: "#fefce8",
      stroke: "#a16207",
    },
    {
      x: 810,
      y: 465,
      w: 360,
      h: 135,
      title: "Operations & Recovery",
      lines: [
        "Runtime Coordinator / drain",
        "lease / DLQ / sweeper / reconcile",
        "trace / metrics / signed audit chain",
      ],
      fill: "#f1f5f9",
      stroke: "#334155",
    },
  ],
  [
    { x1: 280, y1: 95, x2: 335, y2: 95, label: "TLS" },
    { x1: 585, y1: 95, x2: 640, y2: 95 },
    { x1: 890, y1: 95, x2: 945, y2: 95 },
    { x1: 760, y1: 153, x2: 760, y2: 235, label: "transaction" },
    { x1: 640, y1: 153, x2: 160, y2: 235, label: "repository", dx: 0, dy: -10 },
    { x1: 760, y1: 375, x2: 1050, y2: 465, label: "telemetry" },
    { x1: 890, y1: 305, x2: 930, y2: 305, label: "seq" },
    { x1: 160, y1: 375, x2: 210, y2: 465 },
    { x1: 460, y1: 375, x2: 600, y2: 465 },
  ],
  630
);

const userFlowDiagram = diagram(
  "User-to-State Closed Loop",
  [
    {
      x: 25,
      y: 40,
      w: 180,
      h: 90,
      title: "1. User Input",
      lines: ["text / file / action", "device identity"],
      fill: "#eef2ff",
      stroke: "#6366f1",
    },
    {
      x: 225,
      y: 40,
      w: 180,
      h: 90,
      title: "2. Edge",
      lines: ["limit / signature", "session / authz"],
      fill: "#eff6ff",
      stroke: "#2563eb",
    },
    {
      x: 425,
      y: 40,
      w: 180,
      h: 90,
      title: "3. Intent",
      lines: ["route / mode", "Agent decision"],
      fill: "#fdf4ff",
      stroke: "#a21caf",
    },
    {
      x: 625,
      y: 40,
      w: 180,
      h: 90,
      title: "4. Retrieval",
      lines: ["memory + profile", "knowledge + graph"],
      fill: "#fff7ed",
      stroke: "#ea580c",
    },
    {
      x: 825,
      y: 40,
      w: 180,
      h: 90,
      title: "5. Model",
      lines: ["provider execution", "budget / tools"],
      fill: "#fdf4ff",
      stroke: "#a21caf",
    },
    {
      x: 1025,
      y: 40,
      w: 150,
      h: 90,
      title: "6. Response",
      lines: ["Chat SSE", "citations/files"],
      fill: "#ecfdf5",
      stroke: "#059669",
    },
    {
      x: 845,
      y: 230,
      w: 260,
      h: 120,
      title: "7. Authoritative Commit",
      lines: ["domain mutation", "content refs", "version/hash/outbox"],
      fill: "#f8fafc",
      stroke: "#475569",
    },
    {
      x: 500,
      y: 230,
      w: 260,
      h: 120,
      title: "8. Notification",
      lines: ["Outbox seq", "WS primary", "SSE/Push secondary"],
      fill: "#fefce8",
      stroke: "#ca8a04",
    },
    {
      x: 155,
      y: 230,
      w: 260,
      h: 120,
      title: "9. Reliable Apply",
      lines: ["batchGet projection", "encrypted cache commit", "cursor + ACK"],
      fill: "#f0fdfa",
      stroke: "#0f766e",
    },
    {
      x: 155,
      y: 450,
      w: 950,
      h: 105,
      title: "10. Recovery & Verification",
      lines: [
        "manifest on launch · cursor replay · periodic hash sampling · domain ETag/repair · conflict center · offline queue retry",
      ],
      fill: "#f1f5f9",
      stroke: "#334155",
    },
  ],
  [
    { x1: 205, y1: 85, x2: 225, y2: 85 },
    { x1: 405, y1: 85, x2: 425, y2: 85 },
    { x1: 605, y1: 85, x2: 625, y2: 85 },
    { x1: 805, y1: 85, x2: 825, y2: 85 },
    { x1: 1005, y1: 85, x2: 1025, y2: 85 },
    { x1: 1100, y1: 130, x2: 975, y2: 230 },
    { x1: 845, y1: 290, x2: 760, y2: 290 },
    { x1: 500, y1: 290, x2: 415, y2: 290 },
    { x1: 285, y1: 350, x2: 285, y2: 450 },
    { x1: 975, y1: 350, x2: 975, y2: 450 },
    {
      x1: 155,
      y1: 500,
      x2: 25,
      y2: 85,
      label: "next device/session",
      dx: 40,
      dy: 0,
    },
  ],
  590
);

const syncDiagram = diagram(
  "Synchronization Architecture — Consistency Is Not Transport",
  [
    {
      x: 30,
      y: 45,
      w: 250,
      h: 150,
      title: "Client State",
      lines: [
        "domain cache + descriptor",
        "encrypted mutation queue",
        "dirty is local only",
        "lastAppliedSeq",
      ],
      fill: "#eef2ff",
      stroke: "#6366f1",
    },
    {
      x: 340,
      y: 45,
      w: 250,
      h: 150,
      title: "Consistency API",
      lines: [
        "manifest",
        "nodes:batchGet",
        "events after seq",
        "mutations + If-Match",
      ],
      fill: "#eff6ff",
      stroke: "#2563eb",
    },
    {
      x: 650,
      y: 45,
      w: 250,
      h: 150,
      title: "State Tree Metadata",
      lines: [
        "stateVersion authority",
        "SHA-256 hash",
        "server updatedAt",
        "tombstone / visibility",
      ],
      fill: "#f0fdfa",
      stroke: "#0f766e",
    },
    {
      x: 960,
      y: 45,
      w: 210,
      h: 150,
      title: "Domain Authority",
      lines: [
        "business tables",
        "event/cursor domains",
        "object references",
        "permission checks",
      ],
      fill: "#f8fafc",
      stroke: "#475569",
    },
    {
      x: 170,
      y: 300,
      w: 270,
      h: 150,
      title: "Realtime Notification",
      lines: [
        "WS primary",
        "SSE replay",
        "APNs/Web Push wake",
        "payload is hint/checkpoint",
      ],
      fill: "#fefce8",
      stroke: "#ca8a04",
    },
    {
      x: 505,
      y: 300,
      w: 270,
      h: 150,
      title: "Transactional Outbox",
      lines: [
        "global seq",
        "lease / retry / lanes",
        "poison isolation + DLQ",
        "NATS adapter ready",
      ],
      fill: "#fff7ed",
      stroke: "#ea580c",
    },
    {
      x: 840,
      y: 300,
      w: 270,
      h: 150,
      title: "Conflict & Repair",
      lines: [
        "baseVersion + changedPaths",
        "non-overlap auto-rebase",
        "same-field conflict center",
        "hash mismatch re-fetch",
      ],
      fill: "#fdf4ff",
      stroke: "#a21caf",
    },
    {
      x: 170,
      y: 525,
      w: 940,
      h: 115,
      title: "Model Selection Boundary",
      lines: [
        "Ordinary nodes: version or version+hash · Chat: event log + thread cursor · Read position: monotonic max",
        "Collaborative text: future CRDT/OT only with real multi-writer need · Merkle: future large-tree reconcile experiment, not current authority",
      ],
      fill: "#f1f5f9",
      stroke: "#334155",
    },
  ],
  [
    { x1: 280, y1: 120, x2: 340, y2: 120, label: "compare/pull" },
    { x1: 590, y1: 120, x2: 650, y2: 120 },
    { x1: 900, y1: 120, x2: 960, y2: 120, label: "projection" },
    { x1: 1065, y1: 195, x2: 640, y2: 300, label: "same transaction" },
    { x1: 505, y1: 375, x2: 440, y2: 375, label: "seq" },
    { x1: 170, y1: 375, x2: 155, y2: 195, label: "hint" },
    { x1: 775, y1: 375, x2: 840, y2: 375 },
    { x1: 975, y1: 450, x2: 975, y2: 525 },
  ],
  670
);

const agentDiagram = diagram(
  "AI Agent & Memory Architecture",
  [
    {
      x: 30,
      y: 40,
      w: 240,
      h: 130,
      title: "Agent Registry",
      lines: [
        "identity / role",
        "37 provider directories",
        "task registry / model tiers",
      ],
      fill: "#fdf4ff",
      stroke: "#a21caf",
    },
    {
      x: 330,
      y: 40,
      w: 240,
      h: 130,
      title: "Execution Context",
      lines: [
        "token/time/cost reserve",
        "usage settlement",
        "trace / cancellation",
      ],
      fill: "#eef2ff",
      stroke: "#6366f1",
    },
    {
      x: 630,
      y: 40,
      w: 240,
      h: 130,
      title: "Permission Plane",
      lines: [
        "capability manifest",
        "tool/file/network policy",
        "Secret Broker contract",
      ],
      fill: "#eff6ff",
      stroke: "#2563eb",
    },
    {
      x: 930,
      y: 40,
      w: 240,
      h: 130,
      title: "Tool Runtime",
      lines: [
        "12 plugin domains",
        "MCP Hypervisor",
        "scheduled/background jobs",
      ],
      fill: "#fff7ed",
      stroke: "#ea580c",
    },
    {
      x: 30,
      y: 270,
      w: 265,
      h: 160,
      title: "Short / Working Memory",
      lines: [
        "recent thread history",
        "current tool state",
        "bounded context assembly",
        "deterministic compaction",
      ],
      fill: "#fefce8",
      stroke: "#ca8a04",
    },
    {
      x: 325,
      y: 270,
      w: 265,
      h: 160,
      title: "Long-term Memory",
      lines: [
        "candidate + confirmed",
        "structured user memory",
        "persona/profile memory",
        "encrypted domain records",
      ],
      fill: "#fefce8",
      stroke: "#ca8a04",
    },
    {
      x: 620,
      y: 270,
      w: 265,
      h: 160,
      title: "Project Knowledge",
      lines: [
        "workspace documents",
        "vector retrieval",
        "knowledge graph",
        "evidence/provenance",
      ],
      fill: "#fff7ed",
      stroke: "#ea580c",
    },
    {
      x: 915,
      y: 270,
      w: 255,
      h: 160,
      title: "Evaluation & Audit",
      lines: [
        "eval schema ready",
        "quality/safety/cost",
        "tool result store",
        "signed security events",
      ],
      fill: "#f1f5f9",
      stroke: "#334155",
    },
    {
      x: 130,
      y: 525,
      w: 940,
      h: 110,
      title: "Personal AI OS Readiness",
      lines: [
        "Strong foundation: identity, memory layers, retrieval, tools, sync, policy and audit boundaries.",
        "Main gap: production eval corpus, enforce-mode budgets, durable multi-agent coordination, plugin isolation and multi-region operating proof.",
      ],
      fill: "#ecfdf5",
      stroke: "#059669",
    },
  ],
  [
    { x1: 270, y1: 105, x2: 330, y2: 105 },
    { x1: 570, y1: 105, x2: 630, y2: 105 },
    { x1: 870, y1: 105, x2: 930, y2: 105 },
    { x1: 450, y1: 170, x2: 460, y2: 270, label: "context" },
    { x1: 750, y1: 170, x2: 750, y2: 270, label: "retrieval" },
    { x1: 1050, y1: 170, x2: 1040, y2: 270, label: "events" },
    { x1: 620, y1: 430, x2: 620, y2: 525 },
  ],
  665
);

const recoveryDiagram = diagram(
  "Self-Operation, Repair and Disaster Controls",
  [
    {
      x: 35,
      y: 45,
      w: 250,
      h: 135,
      title: "Detect",
      lines: [
        "readiness / RED metrics",
        "cursor lag / hash drift",
        "pool / queue / object health",
      ],
      fill: "#eff6ff",
      stroke: "#2563eb",
    },
    {
      x: 325,
      y: 45,
      w: 250,
      h: 135,
      title: "Contain",
      lines: [
        "fail-closed policies",
        "DLQ / bounded queue",
        "feature/cohort switches",
      ],
      fill: "#fef2f2",
      stroke: "#dc2626",
    },
    {
      x: 615,
      y: 45,
      w: 250,
      h: 135,
      title: "Recover",
      lines: [
        "lease reclaim / retry",
        "cursor replay / reconcile",
        "staging GC / receipt sweep",
      ],
      fill: "#f0fdfa",
      stroke: "#0f766e",
    },
    {
      x: 905,
      y: 45,
      w: 250,
      h: 135,
      title: "Prove",
      lines: [
        "quick/FK checks",
        "canonical hash compare",
        "signed audit checkpoint",
      ],
      fill: "#f8fafc",
      stroke: "#475569",
    },
    {
      x: 35,
      y: 285,
      w: 340,
      h: 150,
      title: "Runtime Lifecycle",
      lines: [
        "HTTP ready before workers",
        "SIGTERM readiness=false",
        "ordered drain ≤30s",
        "supervisor crash-loop control",
      ],
      fill: "#eef2ff",
      stroke: "#6366f1",
    },
    {
      x: 430,
      y: 285,
      w: 340,
      h: 150,
      title: "Data Reconciliation",
      lines: [
        "Auth revision fingerprint",
        "Outbox/receipt reconciliation",
        "content-object ref verification",
        "Sync full-reconcile checkpoint",
      ],
      fill: "#fff7ed",
      stroke: "#ea580c",
    },
    {
      x: 825,
      y: 285,
      w: 330,
      h: 150,
      title: "Migration / Rollback",
      lines: [
        "snapshot + monotonic CDC",
        "write barrier / hash compare",
        "seven-day reverse shadow",
        "no destructive rollback",
      ],
      fill: "#fdf4ff",
      stroke: "#a21caf",
    },
  ],
  [
    { x1: 285, y1: 110, x2: 325, y2: 110 },
    { x1: 575, y1: 110, x2: 615, y2: 110 },
    { x1: 865, y1: 110, x2: 905, y2: 110 },
    { x1: 160, y1: 180, x2: 205, y2: 285 },
    { x1: 740, y1: 180, x2: 600, y2: 285 },
    { x1: 1030, y1: 180, x2: 990, y2: 285 },
  ],
  470
);

const technologyRows = [
  {
    layer: "Web",
    technology:
      "React 18.2, Vite 4, Tailwind, React Router, ECharts/Recharts, XYFlow",
    role: "应用壳、聊天、Reader、可视化、加密缓存与 Sync V2",
    maturity: "生产代码；路由懒加载和 Bundle 门禁已验证",
  },
  {
    layer: "iOS/iPadOS",
    technology:
      "SwiftUI, iOS 26 SDK, URLSession/WebSocket, Keychain, CryptoKit AES-GCM",
    role: "原生会话、受保护缓存、游标与离线队列",
    maturity: "99 项 Simulator 测试基线；需真实授权 E2E 持续验证",
  },
  {
    layer: "Desktop",
    technology:
      "Electron 35, contextIsolation, sandbox, preload bridge, process supervisor",
    role: "Windows/macOS 打包、本地 SQLite 离线模式",
    maturity: "安全策略测试通过；签名发布链需目标平台证明",
  },
  {
    layer: "API",
    technology: "Node.js, Express 4.21, Prisma 5.3, REST/SSE/WebSocket",
    role: "业务 API、AI 流式、领域权限和同步入口",
    maturity: "真实本地运行；HTTP 200",
  },
  {
    layer: "Auth",
    technology:
      "JWT sid/jti, server Session, Passkey/WebAuthn, OPAQUE login, rate limits",
    role: "身份、设备、吊销和登录防护",
    maturity: "权威 Session 已实现；旧 token 有期限迁移",
  },
  {
    layer: "Data",
    technology:
      "SQLite + better-sqlite3 active; PostgreSQL dual schema/client ready",
    role: "领域权威、Auth 权威、事务与在线迁移",
    maturity: "SQLite 实测；PostgreSQL 尚需外部 staging cutover",
  },
  {
    layer: "Content",
    technology:
      "Local CAS active; AWS SDK S3/MinIO adapter; multipart/checksum",
    role: "Chat/Patrol 大对象、Blob 按需读取",
    maturity: "真实数据迁移完成；外部 S3 故障演练待办",
  },
  {
    layer: "Realtime",
    technology:
      "Transactional Outbox, memory transport active, NATS JetStream adapter",
    role: "可靠通知、durable consumer、Gateway/Push",
    maturity: "单实例实测；NATS 多实例待 staging",
  },
  {
    layer: "Knowledge",
    technology:
      "Collector, Reader workers, LangChain, OCR, 10 vector providers, knowledge graph",
    role: "采集、解析、索引、检索与证据图谱",
    maturity: "多 Provider 适配；规模隔离仍依赖部署拓扑",
  },
  {
    layer: "AI",
    technology:
      "37 LLM provider directories, ModelExecutionContext, tool runtime, usage/budget/eval schema",
    role: "模型路由、Agent、成本和质量治理",
    maturity: "核心运行成熟；治理处于 observe→enforce 过渡",
  },
  {
    layer: "Security",
    technology:
      "AES-256-GCM, HKDF domain separation, SHA-256 chains, Ed25519 checkpoints",
    role: "数据机密性、对象 DEK、日志完整性和签名证明",
    maturity: "Key Custody 边界已审计；KMS/Vault 为适配接口",
  },
  {
    layer: "Operations",
    technology:
      "Runtime Coordinator, Prometheus/OTel API, Grafana/Tempo/Loki configs",
    role: "就绪、排空、追踪、指标、日志和恢复",
    maturity: "本地/CI 配置已交付；长期 SLO 数据待生产积累",
  },
];

const moduleRows = [
  {
    module: "Web Application Shell",
    purpose: "路由、认证、主题、Workspace 壳与能力懒加载",
    inputs: "用户操作、路由、Session、Sync 投影",
    outputs: "领域 API 调用、视觉更新、本地缓存",
    status: "边界清晰",
    issue: "部分大页面仍是 God File",
    recommendation: "继续按能力/路由拆分，不改变导航缓存",
  },
  {
    module: "iOS Workspace/Conversation Centers",
    purpose: "原生导航、会话、缓存和同步投影",
    inputs: "REST/WS/Push、Keychain cursor",
    outputs: "SwiftUI 状态、受保护 Archive、ACK",
    status: "核心闭环完成",
    issue: "两个 4k–5k 行 owner",
    recommendation: "抽离 coordinator；保持 MainActor 所有权",
  },
  {
    module: "Desktop Runtime",
    purpose: "离线桌面模式与子进程生命周期",
    inputs: "Electron IPC、local storage",
    outputs: "本地 API/Collector/UI",
    status: "安全基线完成",
    issue: "云端共享状态不是本地 DB 的自然能力",
    recommendation: "远程权威模式显式化，离线模式保持设备隔离",
  },
  {
    module: "Request Edge",
    purpose: "按路由限制 Body、签名、关联 ID 和错误语义",
    inputs: "HTTP/raw/multipart/webhook",
    outputs: "有界且已验证的请求",
    status: "P0 完成",
    issue: "策略表需随新路由持续维护",
    recommendation: "CI 强制每个上传/Raw 路由声明 limit class",
  },
  {
    module: "Auth Session Center",
    purpose: "统一登录方式、服务端 Session、设备吊销",
    inputs: "password/passkey/OPAQUE/SSO",
    outputs: "sid/jti token、Session 事件",
    status: "权威链完成",
    issue: "Main/Auth 跨库通知不是原子事务",
    recommendation: "维持 revision fingerprint + periodic reconcile",
  },
  {
    module: "Authorization & Capability",
    purpose: "Workspace/resource/Agent/tool 访问控制",
    inputs: "identity、membership、capability manifest",
    outputs: "allow/deny 与审计",
    status: "多层已落地",
    issue: "插件隔离证明不足",
    recommendation: "高风险工具仅在容器/Secret Broker 完成后开放",
  },
  {
    module: "Workspace Domain",
    purpose: "工作区、成员、线程、活动与配置",
    inputs: "用户 mutation、权限上下文",
    outputs: "领域行、Sync 节点与事件",
    status: "领域自治",
    issue: "历史 API 兼容面仍存在",
    recommendation: "按 cohort 退役，保留回滚窗口",
  },
  {
    module: "Chat Domain",
    purpose: "消息、编辑/删除、SSE、历史和 Hash Chain",
    inputs: "prompt、attachments、Agent output",
    outputs: "message/event/cursor/content refs",
    status: "高频路径优化完成",
    issue: "编辑/删除仍需范围重建",
    recommendation: "研究链检查点，不为普通 append 引入 Event Sourcing",
  },
  {
    module: "Content Object Plane",
    purpose: "大对象 staging、加密、引用和 GC",
    inputs: "file/text/tool output",
    outputs: "immutable object + authorized reference",
    status: "本地实测",
    issue: "S3/MinIO 未实网演练",
    recommendation: "staging 做 checksum/timeout/GC/failure matrix",
  },
  {
    module: "Reader & Collector",
    purpose: "文档采集、解析、隔离和投影",
    inputs: "URL/file/repository connectors",
    outputs: "normalized docs/chunks/index jobs",
    status: "模块化 worker",
    issue: "第三方解析器和网络出口风险",
    recommendation: "继续 fail-closed sandbox 与格式 allowlist",
  },
  {
    module: "Knowledge & Vector",
    purpose: "嵌入、语义检索、知识图谱和来源证据",
    inputs: "documents/chunks/query",
    outputs: "ranked evidence/graph projection",
    status: "多 Provider",
    issue: "跨 Provider 一致容量模型有限",
    recommendation: "为 10k+ 租户建立 provider SLO 与 reindex budget",
  },
  {
    module: "Memory",
    purpose: "短期、工作、长期、用户与项目记忆",
    inputs: "chat/feedback/profile/project context",
    outputs: "bounded context/structured memory",
    status: "分层基础良好",
    issue: "质量 eval 与遗忘策略仍需数据",
    recommendation: "建立 consent、decay、provenance 和 memory eval",
  },
  {
    module: "AI Orchestration",
    purpose: "Provider 路由、预算、用量和模型任务",
    inputs: "execution context/prompt/policy",
    outputs: "stream/result/usage event",
    status: "AI-native",
    issue: "价格和用量执行未覆盖全部 Provider",
    recommendation: "observe 后逐域 enforce，未知价格仍限制 token/time/tool",
  },
  {
    module: "Agent/MCP Runtime",
    purpose: "工具调用、插件服务身份和任务执行",
    inputs: "Agent plan/capabilities/secrets",
    outputs: "tool result/audit/events",
    status: "能力面完整",
    issue: "多 Agent 协同仍是应用级而非协议级",
    recommendation: "先完善权限/评估，再建设 durable coordination",
  },
  {
    module: "Sync V2",
    purpose: "跨设备一致性控制面",
    inputs: "domain changes/client mutations",
    outputs: "manifest/node/event/cursor/conflict",
    status: "协议与客户端完成",
    issue: "当前开发环境全局关闭",
    recommendation: "deterministic cohort：shadow→Web→TestFlight→core",
  },
  {
    module: "Outbox & Realtime",
    purpose: "事务变更、可靠分发和断线恢复",
    inputs: "same-transaction domain event",
    outputs: "seq/WS/SSE/Push/NATS",
    status: "单实例完整，分布式适配就绪",
    issue: "真实多实例未证明",
    recommendation: "NATS 健康必须是 Gateway readiness 前提",
  },
  {
    module: "Data Access Center",
    purpose: "Repository 权威、事务注入和错误语义",
    inputs: "domain query/mutation",
    outputs: "typed data or observable 503",
    status: "假健康已清理",
    issue: "19 个受治理的非 DB fallback",
    recommendation: "逐项证明领域空值语义，不机械删除",
  },
  {
    module: "Runtime Coordinator",
    purpose: "启动、ready、drain、shutdown 与 worker 顺序",
    inputs: "process signals/dependency health",
    outputs: "readiness/lifecycle actions",
    status: "P1 完成",
    issue: "跨主机编排依赖部署平台",
    recommendation: "在 Kubernetes/VM staging 做 SIGTERM/partition drills",
  },
  {
    module: "Observability & Audit",
    purpose: "trace/metrics/log/security evidence",
    inputs: "API/repo/outbox/client ACK/security event",
    outputs: "SLO/alert/signed archive",
    status: "控制面就绪",
    issue: "缺长期生产时间序列",
    recommendation: "以 p95/error budget 驱动下一轮容量决策",
  },
  {
    module: "CI/CD & Release",
    purpose: "测试、供应链、构建、容器和发布",
    inputs: "source/lockfiles/workflows",
    outputs: "gated artifact/tag/image",
    status: "11 个 workflow",
    issue: "High 依赖仍受策略治理",
    recommendation: "Critical=0 hard gate；High owner/isolation/expiry",
  },
];

const dataRows = [
  {
    domain: "Identity & Session",
    authority: "Auth DB",
    consistency: "Session/version + revision fingerprint",
    lifecycle: "idle/absolute expiry, revoke, deletion workflow",
    recovery: "FK audit + periodic cross-DB reconcile",
  },
  {
    domain: "Profile & Preferences",
    authority: "Main domain tables",
    consistency: "version + hash; baseVersion patch",
    lifecycle: "account lifetime + deletion",
    recovery: "manifest/batchGet/hash repair",
  },
  {
    domain: "Workspace & Membership",
    authority: "Main domain tables",
    consistency: "transactional version/hash + permission recheck",
    lifecycle: "workspace/member lifecycle",
    recovery: "tombstone + authorization reconcile",
  },
  {
    domain: "Chat Messages",
    authority: "workspace_chats + domain event/cursor",
    consistency: "append ID, messageVersion, history cursor, Hash Chain",
    lifecycle: "thread retention/export/delete",
    recovery: "incremental history + ETag + chain rebuild",
  },
  {
    domain: "Attachments / Large Text",
    authority: "Content Object Store + DB refs",
    consistency: "checksum + immutable object + refCount",
    lifecycle: "staging, ready, grace deletion",
    recovery: "reconciler + orphan GC + reference audit",
  },
  {
    domain: "Documents & Reader",
    authority: "document tables/files/object refs",
    consistency: "metadata version/hash; processing cursor",
    lifecycle: "ingest/index/archive/delete",
    recovery: "worker retry + source projection",
  },
  {
    domain: "Vectors",
    authority: "selected vector provider",
    consistency: "document/chunk identity + index status",
    lifecycle: "reindex/provider retention",
    recovery: "re-embed from authoritative document",
  },
  {
    domain: "Knowledge Graph",
    authority: "graph/domain tables",
    consistency: "node/edge revision + projection",
    lifecycle: "recompute/backfill/repair",
    recovery: "metric recompute + graph repair scripts",
  },
  {
    domain: "Memory & Persona",
    authority: "user/workspace memory tables",
    consistency: "candidate/confirmed state + version/hash",
    lifecycle: "consent, decay, delete",
    recovery: "projection audit + structured rebuild",
  },
  {
    domain: "Agent / Task / Meeting",
    authority: "domain records + append-only run events",
    consistency: "run cursor/idempotency/typed state",
    lifecycle: "run retention + audit",
    recovery: "job retry/compaction/reconcile",
  },
  {
    domain: "Sync Metadata",
    authority: "sync_nodes/outbox/cursors/receipts",
    consistency: "monotonic stateVersion and seq",
    lifecycle: "30-day event window + checkpoint",
    recovery: "lease/sweeper/DLQ/full reconcile",
  },
  {
    domain: "Security & Operations",
    authority: "event logs + signed archive",
    consistency: "SHA-256 chain + Ed25519 checkpoint",
    lifecycle: "retention/SIEM policy",
    recovery: "verification, retry spool, immutable export",
  },
];

const syncRows = [
  {
    state: "Profile, settings, workspace/thread metadata",
    model: "stateVersion + SHA-256 hash",
    transport: "WS hint + manifest/batchGet",
    conflict: "baseVersion + changedPaths; same-field conflict center",
    tree: "Yes",
  },
  {
    state: "Security, permission, sessions, entitlements",
    model: "version + authoritative domain re-read",
    transport: "WS/SSE/Push invalidation",
    conflict: "server policy only; stale cache cannot grant",
    tree: "Metadata/invalidation only",
  },
  {
    state: "Chat messages",
    model: "event log + thread cursor + messageVersion",
    transport: "Chat SSE for tokens; WS hint; incremental history",
    conflict: "append idempotency, edit CAS, tombstone",
    tree: "Descriptor only",
  },
  {
    state: "Read position",
    model: "monotonic maximum cursor",
    transport: "delayed merge push",
    conflict: "max wins, never regress",
    tree: "Yes",
  },
  {
    state: "Draft",
    model: "versioned value today; CRDT only for real concurrent editing",
    transport: "delayed merge + on-demand pull",
    conflict: "explicit version conflict",
    tree: "Yes",
  },
  {
    state: "Collaborative document body",
    model: "future OT/CRDT operation log",
    transport: "dedicated collaboration channel",
    conflict: "causal merge",
    tree: "No body; metadata only",
  },
  {
    state: "Index/parse/batch status",
    model: "append-only status events + cursor",
    transport: "domain event stream",
    conflict: "state machine / logical clock",
    tree: "Projection only",
  },
  {
    state: "Blob, token stream, media, market ticks, secrets",
    model: "domain stream/object/secret store",
    transport: "specialized channel",
    conflict: "domain-specific",
    tree: "No",
  },
];

const securityRows = [
  {
    control: "Authentication",
    current:
      "Server Session; JWT sid/jti; password, Passkey, OPAQUE, invite, SSO",
    assurance: "High",
    gap: "Production identity federation and recovery drills",
  },
  {
    control: "Authorization",
    current: "Account role + Workspace/resource + capability policy",
    assurance: "High",
    gap: "Plugin identities and tenant policy need staging proof",
  },
  {
    control: "Transport",
    current: "HTTPS/TLS, request signatures, nonce/replay controls",
    assurance: "Medium-high; development is warn-only",
    gap: "Production must enable strict signing/device policy; multi-region mTLS is future work",
  },
  {
    control: "At-rest encryption",
    current: "AES-256-GCM for records/archives; per-object random DEK",
    assurance: "High",
    gap: "External KMS/Vault migration not executed",
  },
  {
    control: "Key derivation",
    current:
      "HKDF domain separation for object fingerprints, plugins and audit signing",
    assurance: "High",
    gap: "Document formal cryptographic domain registry",
  },
  {
    control: "Integrity",
    current: "Chat/security SHA-256 Hash Chains; Ed25519 signed checkpoints",
    assurance: "High",
    gap: "Immutable external archive/SIEM not yet exercised",
  },
  {
    control: "Secrets",
    current:
      "Key Custody boundary, redaction, capability/Secret Broker contract",
    assurance: "Medium-high",
    gap: "Containerized high-risk tools and short-lived broker credentials",
  },
  {
    control: "Isolation",
    current:
      "Collector SSRF/archive guards; Electron sandbox; account/workspace checks",
    assurance: "Medium-high",
    gap: "Host/container policy proof across every deployment target",
  },
  {
    control: "Privacy",
    current:
      "Tenant-scoped content fingerprint, encrypted caches, deletion workflow",
    assurance: "Medium-high",
    gap: "Formal data classification, residency and DSR SLO",
  },
  {
    control: "Advanced cryptography",
    current:
      "OPAQUE is scoped to login; no general ZKP, threshold signature, Shamir or app-level double ratchet",
    assurance: "Appropriately deferred",
    gap: "Introduce only for explicit custody/compliance threat models",
  },
];

const scaleRows = [
  {
    users: "100",
    assumedConcurrent: 5,
    modeledControlRps: 10,
    requiredTopology: "Current single-instance or managed PostgreSQL",
    firstBottleneck: "AI provider latency/cost, local disk headroom",
    readiness: "Ready for controlled use",
  },
  {
    users: "1,000",
    assumedConcurrent: 50,
    modeledControlRps: 100,
    requiredTopology: "PostgreSQL + object store; worker isolation",
    firstBottleneck: "SQLite write serialization, connection/read queues",
    readiness: "Staging validation required",
  },
  {
    users: "10,000",
    assumedConcurrent: 500,
    modeledControlRps: 1000,
    requiredTopology: "Horizontal API/workers + NATS + S3 + observability",
    firstBottleneck: "DB pools, vector tenancy, Gateway fan-out, AI budgets",
    readiness: "Architecture-ready, not production-proven",
  },
  {
    users: "100,000",
    assumedConcurrent: 5000,
    modeledControlRps: 10000,
    requiredTopology: "Partitioned multi-region control/data planes",
    firstBottleneck: "tenant sharding, global identity, DR, cost governance",
    readiness: "Capacity model only",
  },
];

const debtRows = [
  {
    priority: "Critical",
    item: "Open confirmed local P0 defects",
    currentImpact: "None in the verified v2.3 scope",
    futureRisk: "New routes/providers may bypass policy",
    action: "Keep fail-closed CI gates; do not claim production certification",
  },
  {
    priority: "High",
    item: "External PostgreSQL/NATS/S3/OTel cutover proof",
    currentImpact: "Distributed mode cannot be certified",
    futureRisk: "failover, redelivery or pool behavior may diverge",
    action: "Docker-capable staging fault matrix before cloud cutover",
  },
  {
    priority: "High",
    item: "Supply-chain High findings",
    currentImpact:
      "114 Server + 40 Collector + 11 Frontend raw High; reachable Critical=0",
    futureRisk: "future reachability or exploit chain",
    action: "Owner/isolation/expiry and tested same-major upgrades",
  },
  {
    priority: "High",
    item: "Sync V2 rollout evidence",
    currentImpact: "Healthy tree is globally disabled in current environment",
    futureRisk: "benefits and SLO are not yet production-proven",
    action: "Deterministic cohort with hash/reconcile/TTI gates",
  },
  {
    priority: "High",
    item: "Authenticated cross-device E2E",
    currentImpact: "Static/fault tests exceed runtime evidence",
    futureRisk: "browser/iOS lifecycle regressions",
    action: "Dedicated authorized test tenants and device matrix",
  },
  {
    priority: "High",
    item: "Production security-policy enforcement",
    currentImpact:
      "The reviewed development policy reports request-signing warn-only and strictReady=false",
    futureRisk:
      "A production environment copied from development could accept unsigned high-risk requests",
    action:
      "Make strict signing/device policy a production readiness gate and verify rollback-safe client coverage",
  },
  {
    priority: "Medium",
    item: "Seven governed God Files",
    currentImpact: "Review and ownership cost",
    futureRisk: "change coupling and test isolation",
    action: "Incremental controller/service extraction; no-growth gate",
  },
  {
    priority: "Medium",
    item: "Legacy compatibility",
    currentImpact: "204 small Payload V1 records and old API paths remain",
    futureRisk: "dual-path maintenance",
    action: "Usage-based deprecation after two stable releases/30 days",
  },
  {
    priority: "Medium",
    item: "Production SLO history",
    currentImpact: "Local metrics reset and AI usage sample is empty",
    futureRisk: "capacity decisions lack longitudinal evidence",
    action: "Persist OTel/Prometheus series and cost/eval telemetry",
  },
  {
    priority: "Medium",
    item: "Plugin execution isolation",
    currentImpact:
      "Capability broker exists, universal container proof does not",
    futureRisk: "filesystem/network/secret blast radius",
    action: "High-risk tools fail closed outside isolated runtime",
  },
  {
    priority: "Medium",
    item: "macOS native image/document library namespace",
    currentImpact:
      "The complete Jest process reports a duplicate Objective-C class from Sharp/libvips and Canvas/libgio; all tests still pass",
    futureRisk:
      "Spurious native casts or crashes when both stacks share one process",
    action:
      "Move native image/document transforms behind dedicated worker processes and verify macOS desktop packaging",
  },
  {
    priority: "Medium",
    item: "Mixed static/dynamic Web imports",
    currentImpact:
      "Navigation, thread history and Sync stores are dynamically requested by cleanup/restore paths but statically retained by active UI paths",
    futureRisk:
      "Further route splitting yields less than expected entry/chunk reduction",
    action:
      "Split pure persistence adapters from live stores before changing existing navigation/cache semantics",
  },
  {
    priority: "Low",
    item: "Merkle/CRDT/general Event Sourcing",
    currentImpact: "No current correctness deficit for ordinary nodes",
    futureRisk: "future collaborative scale may need new model",
    action: "Experiment only after measured reconcile or multi-writer demand",
  },
];

const roadmapRows = [
  {
    phase: "Phase 1 — v2.3 current optimization",
    horizon: "0–3 months",
    modules:
      "Content Objects, Sync cohort, observability evidence, remaining P0/P1 gates",
    architectureChange:
      "Keep domain authority; activate control planes progressively",
    benefit: "Lower load, reliable recovery, measurable SLO",
  },
  {
    phase: "Phase 2 — Enterprise Stable",
    horizon: "3–12 months",
    modules: "Managed PostgreSQL/NATS/S3/KMS, tenant policy, DR, SIEM, E2E lab",
    architectureChange:
      "Horizontal stateless services + separated workers/gateway",
    benefit: "10k-user class operating model and compliance evidence",
  },
  {
    phase: "Phase 3 — Personal AI OS",
    horizon: "12–30 months",
    modules:
      "Memory governance/eval, durable personal policy, cross-app context, budget enforcement",
    architectureChange:
      "User-owned memory/permission plane across clients and agents",
    benefit: "Trustworthy persistent personal intelligence",
  },
  {
    phase: "Phase 4 — Multi-Agent Civilization",
    horizon: "30–60 months",
    modules:
      "Agent identity federation, coordination log, market/contract policy, simulation/evaluation",
    architectureChange:
      "Multi-agent control plane with scoped delegation and verifiable audit",
    benefit:
      "Safe autonomous collaboration without turning Sync V2 into a business bus",
  },
];

const scoreRows = [
  {
    dimension: "Architecture Quality",
    score: 8.4,
    basis:
      "Clear domain/control/data-plane boundaries; legacy paths intentionally preserved",
    fiveYearTarget: 9.2,
  },
  {
    dimension: "Scalability",
    score: 7.4,
    basis:
      "Distributed adapters ready, but external multi-node cutover unproven",
    fiveYearTarget: 9.0,
  },
  {
    dimension: "Maintainability",
    score: 7.2,
    basis: "Typed data errors and governance strong; seven God Files remain",
    fiveYearTarget: 8.8,
  },
  {
    dimension: "Security",
    score: 8.3,
    basis:
      "Session, AEAD, custody, signed audit and fail-closed ingress; external KMS/SIEM pending",
    fiveYearTarget: 9.3,
  },
  {
    dimension: "AI Native Capability",
    score: 8.7,
    basis:
      "Provider/Agent/Memory/Knowledge foundations are broad; eval and enforce coverage incomplete",
    fiveYearTarget: 9.4,
  },
  {
    dimension: "Future Expansion",
    score: 8.8,
    basis:
      "Adapters, domain autonomy and protocol boundaries support staged evolution",
    fiveYearTarget: 9.4,
  },
];

const performanceRows = [
  { metric: "Chat DB footprint", reductionPct: 91.57 },
  { metric: "Warm-start requests", reductionPct: 72.41 },
  { metric: "Warm-start payload", reductionPct: 99.47 },
  { metric: "Active warm requests", reductionPct: 85.19 },
  { metric: "Active warm payload", reductionPct: 99.73 },
  { metric: "Active cold payload", reductionPct: 57.21 },
];

const cards = [
  {
    id: "overall_score",
    dataset: "headline",
    sourceId: "release_evidence",
    description:
      "Weighted current architecture evaluation; not a compliance certification.",
    metrics: [
      {
        label: "Overall architecture score",
        field: "overallScore",
        format: "number",
      },
    ],
  },
  {
    id: "db_reduction",
    dataset: "headline",
    sourceId: "release_evidence",
    description:
      "Real development SQLite reduction after Chat content migration.",
    metrics: [
      {
        label: "Chat database footprint reduction",
        field: "dbReduction",
        format: "percent",
      },
    ],
  },
  {
    id: "warm_payload",
    dataset: "headline",
    sourceId: "release_evidence",
    description:
      "All-account warm-start business payload reduction versus legacy flow.",
    metrics: [
      {
        label: "Warm-start payload reduction",
        field: "warmPayloadReduction",
        format: "percent",
      },
    ],
  },
  {
    id: "sync_integrity",
    dataset: "headline",
    sourceId: "release_evidence",
    description:
      "Reviewed Sync projections without access, payload, hash or projection conflict.",
    metrics: [
      {
        label: "Sync projection integrity",
        field: "syncIntegrity",
        format: "percent",
      },
    ],
  },
  {
    id: "test_total",
    dataset: "headline",
    sourceId: "release_evidence",
    description:
      "Server/Collector, Web Node, iOS and Desktop automated tests in the release evidence set.",
    metrics: [
      { label: "Automated tests", field: "testTotal", format: "compact" },
    ],
  },
  {
    id: "god_files",
    dataset: "headline",
    sourceId: "release_evidence",
    description:
      "Governed files over 3,000 lines after the v2.3 Mind Map split.",
    metrics: [
      { label: "Governed God Files", field: "godFiles", format: "number" },
    ],
  },
];

const charts = [
  {
    id: "performance_improvements",
    title: "Measured data-flow reductions",
    subtitle:
      "Real development data and deterministic Sync V2 benchmark; percentage reduction versus the prior path.",
    type: "bar",
    dataset: "performance",
    sourceId: "release_evidence",
    encodings: {
      x: { field: "metric", type: "ordinal", label: "Metric" },
      y: {
        field: "reductionPct",
        type: "quantitative",
        label: "Reduction",
        format: "number",
        unit: "%",
      },
    },
    yAxisTitle: "Reduction (%)",
    valueFormat: "number",
    unit: "%",
    layout: "full",
  },
  {
    id: "architecture_scores",
    title: "Architecture evaluation scorecard",
    subtitle:
      "Current-state evidence score on a 10-point scale; external production proof caps scalability and operations ratings.",
    type: "bar",
    dataset: "scores",
    sourceId: "release_evidence",
    encodings: {
      x: { field: "dimension", type: "ordinal", label: "Dimension" },
      y: {
        field: "score",
        type: "quantitative",
        label: "Score",
        format: "number",
      },
    },
    yAxisTitle: "Score / 10",
    valueFormat: "number",
    layout: "full",
    referenceLines: [{ value: 8, label: "Strong architecture threshold" }],
  },
  {
    id: "capacity_model",
    title: "Control-plane capacity scenario",
    subtitle:
      "Planning model only: 5% concurrent users and two non-AI control requests per active user per second.",
    type: "bar",
    dataset: "scale",
    sourceId: "release_evidence",
    encodings: {
      x: { field: "users", type: "ordinal", label: "Registered users" },
      y: {
        field: "modeledControlRps",
        type: "quantitative",
        label: "Modeled control RPS",
        format: "compact",
      },
    },
    yAxisTitle: "Modeled control requests/s",
    valueFormat: "compact",
    layout: "full",
  },
];

const table = (
  id,
  title,
  subtitle,
  dataset,
  columns,
  defaultSort,
  sourceId = "release_evidence"
) => ({
  id,
  title,
  subtitle,
  showDescription: true,
  dataset,
  sourceId,
  defaultSort,
  density: "dense",
  layout: "full",
  columns,
});

const tables = [
  table(
    "technology_stack",
    "Technology stack by layer",
    "Current implementation and proof boundary, reviewed for the v2.3 release.",
    "technology",
    [
      { field: "layer", label: "Layer", type: "text" },
      { field: "technology", label: "Technology", type: "text" },
      { field: "role", label: "Role", type: "text" },
      { field: "maturity", label: "Maturity / proof boundary", type: "text" },
    ],
    { field: "layer", direction: "asc" }
  ),
  table(
    "module_matrix",
    "Module Responsibility Matrix & Dependency Map",
    "Why each core module exists, its current condition and the least-invasive next boundary.",
    "modules",
    [
      { field: "module", label: "Module", type: "text" },
      {
        field: "purpose",
        label: "Why it exists / responsibility",
        type: "text",
      },
      { field: "inputs", label: "Inputs", type: "text" },
      { field: "outputs", label: "Outputs", type: "text" },
      { field: "status", label: "Current state", type: "text" },
      { field: "issue", label: "Issue / overlap", type: "text" },
      { field: "recommendation", label: "Recommendation", type: "text" },
    ],
    { field: "module", direction: "asc" }
  ),
  table(
    "data_map",
    "Enterprise Data Architecture Map",
    "Authority, consistency, lifecycle and recovery are intentionally domain-specific.",
    "data",
    [
      { field: "domain", label: "Data domain", type: "text" },
      { field: "authority", label: "Authority", type: "text" },
      { field: "consistency", label: "Consistency model", type: "text" },
      { field: "lifecycle", label: "Lifecycle", type: "text" },
      { field: "recovery", label: "Recovery", type: "text" },
    ],
    { field: "domain", direction: "asc" }
  ),
  table(
    "sync_model_matrix",
    "Synchronization model selection",
    "The state tree coordinates consistency; it does not replace domain streams, blobs or secrets.",
    "syncModels",
    [
      { field: "state", label: "State / message source", type: "text" },
      { field: "model", label: "Consistency model", type: "text" },
      { field: "transport", label: "Transport", type: "text" },
      { field: "conflict", label: "Conflict policy", type: "text" },
      { field: "tree", label: "State-tree fit", type: "text" },
    ],
    { field: "state", direction: "asc" }
  ),
  table(
    "security_matrix",
    "Zero-Trust Security Review",
    "Assurance is scored against the current local/runtime evidence, not external certification.",
    "security",
    [
      { field: "control", label: "Control", type: "text" },
      { field: "current", label: "Current design", type: "text" },
      { field: "assurance", label: "Assurance", type: "text" },
      { field: "gap", label: "Remaining gap", type: "text" },
    ],
    { field: "control", direction: "asc" }
  ),
  table(
    "scale_matrix",
    "Scale scenario and first bottleneck",
    "Assumption-driven capacity planning; 100,000-user case is not a single-host benchmark.",
    "scale",
    [
      { field: "users", label: "Users", type: "text" },
      {
        field: "assumedConcurrent",
        label: "Assumed concurrent",
        format: "number",
      },
      {
        field: "modeledControlRps",
        label: "Modeled control RPS",
        format: "compact",
      },
      { field: "requiredTopology", label: "Required topology", type: "text" },
      { field: "firstBottleneck", label: "First bottleneck", type: "text" },
      { field: "readiness", label: "Readiness", type: "text" },
    ],
    { field: "modeledControlRps", direction: "asc" }
  ),
  table(
    "debt_map",
    "Technical Debt Map",
    "Priority reflects user impact and production risk, not novelty of the technology.",
    "debt",
    [
      { field: "priority", label: "Priority", type: "text" },
      { field: "item", label: "Debt / evidence gap", type: "text" },
      { field: "currentImpact", label: "Current impact", type: "text" },
      { field: "futureRisk", label: "Future risk", type: "text" },
      { field: "action", label: "Required action", type: "text" },
    ],
    { field: "priority", direction: "asc" }
  ),
  table(
    "roadmap",
    "Athena five-year evolution roadmap",
    "Each phase preserves domain authority and adds only the control plane needed for the next operating scale.",
    "roadmap",
    [
      { field: "phase", label: "Phase", type: "text" },
      { field: "horizon", label: "Horizon", type: "text" },
      { field: "modules", label: "New/expanded modules", type: "text" },
      {
        field: "architectureChange",
        label: "Architecture change",
        type: "text",
      },
      { field: "benefit", label: "Technical benefit", type: "text" },
    ],
    { field: "phase", direction: "asc" }
  ),
  table(
    "score_detail",
    "Final Architecture Evaluation Score",
    "Evidence-based current score and target state; scores are architectural judgement, not benchmark outputs.",
    "scores",
    [
      { field: "dimension", label: "Dimension", type: "text" },
      { field: "score", label: "Current / 10", format: "number" },
      { field: "basis", label: "Evidence basis", type: "text" },
      { field: "fiveYearTarget", label: "Five-year target", format: "number" },
    ],
    { field: "score", direction: "desc" }
  ),
];

const md = (id, body, sourceId) => ({
  id,
  type: "markdown",
  body,
  ...(sourceId ? { sourceId } : {}),
});
const html = (id, body) => ({ id, type: "html", body, layout: "full" });

const blocks = [
  md(
    "title",
    "# Athena System Architecture Blueprint & Technical Due Diligence Report"
  ),
  md("executive_summary_heading", "## Executive Summary"),
  md(
    "technical_summary",
    `## Technical Summary — v2.3 已形成可演进的 AI 原生平台，而不是完成了所有生产证明\n\n**结论：Athena 当前架构达到强健的产品级与准企业级水平。** 它已经把业务权威、内容对象、跨设备一致性、实时通知、AI 编排、安全和运行治理拆成边界清晰的层；真实开发库中的 Chat 热数据从 1,007,104,000 B 降至 84,914,176 B（**-91.57%**），Sync V2 暖启动业务载荷降低 **99.47%**，263 个状态节点和 186 个领域投影没有权限、正文、Hash 或投影冲突。\n\n**最领先的部分**是“业务领域自治 + Sync V2 一致性控制面 + 多条传输链路”的组合：Outbox 是事务事实，WS/SSE/Push 只是通知，Manifest/BatchGet/cursor/hash 才是最终校验与修复。Chat、Blob、权限和协作数据没有被粗暴塞进同一种状态模型。\n\n**最重要的限制**是生产规模证明仍落后于代码准备度。PostgreSQL、NATS JetStream、S3/MinIO、OTel/Prometheus 的适配、迁移和故障测试已经交付，但这台工作站没有获准的外部多节点环境，因此不能把“adapter ready”写成“production proven”。当前开发环境的 Sync V2 也仍是全局关闭状态，必须按 cohort 灰度。\n\n**v2.3 本轮新增闭环**：Mind Map 的纯投影边界从 3,081 行 owner 中拆出，受治理 God File 从 8 降至 7，并修复简化模式可能过滤主路径边的既有缺陷。剩余 204 条 Chat Payload V1 经真实 dry-run 确认为小型兼容数据，无内联附件、超大正文或可压缩 Agent 事件，因此没有为“版本整齐”强制重写。`,
    "release_evidence"
  ),
  md(
    "measurement_contract",
    "## Evidence Contract — 三种证据不可混用\n\n- **真实本地证据**：当前开发 SQLite、Local Content Store、memory transport、Web/API/Collector 运行态、真实 Chat/Sync 数据、自动化测试和构建门禁。\n- **实现与故障测试证据**：PostgreSQL/NATS/S3、KMS/Vault、OTel 外接适配和迁移流程；证明接口与失败语义，不证明云端容量或可用性。\n- **容量模型**：100–100,000 用户按明确并发与请求假设推演；用于定位第一瓶颈，不是吞吐基准。\n\n性能“降低”均以升级前 legacy 路径为分母；Sync 完整性以本次只读投影样本为分母；评分是架构委员会判断，不是合规认证。"
  ),
  {
    id: "headline_metrics",
    type: "metric-strip",
    cardIds: [
      "overall_score",
      "db_reduction",
      "warm_payload",
      "sync_integrity",
      "test_total",
      "god_files",
    ],
  },
  md(
    "landscape_heading",
    "## System Landscape — 从用户体验到基础设施形成八层闭环\n\nAthena 的主干不是单体或微服务标签，而是明确的权威和生命周期：客户端拥有加密本地状态；应用服务执行身份与领域策略；AI/Knowledge/Memory 提供智能上下文；Data Layer 保存事实；Infrastructure Layer 负责可靠运行和可回滚演进。"
  ),
  html("landscape_diagram", landscapeDiagram),
  {
    id: "technology_table",
    type: "table",
    tableId: "technology_stack",
    layout: "full",
  },
  md(
    "topology_heading",
    "## Architecture Topology — 控制面、数据面和通知面彼此独立\n\nDomain API 与 Repository 维持业务自治；Content Plane 只处理大对象；Sync Control Plane 只保存版本、Hash、游标和引用；Delivery Plane 可以换成 memory 或 NATS，却不能成为业务数据库。这个拓扑降低了升级时的爆炸半径，也允许桌面离线模式和云端分布式模式共享协议而不共享错误假设。"
  ),
  html("topology_diagram", topologyDiagram),
  md("module_dependency_heading", "## Module Dependency Map"),
  {
    id: "module_table",
    type: "table",
    tableId: "module_matrix",
    layout: "full",
  },
  md("data_flow_map_heading", "## Data Flow Map"),
  md(
    "flow_heading",
    "## User Journey — 每次操作都闭环到权威提交、通知、可靠应用和恢复\n\n用户输入先经过有界解析、签名、Session 和资源权限；随后才进入意图/Agent、Memory、Knowledge 和模型执行。流式响应不等于状态已提交：最终领域写、对象引用、状态版本和 Outbox 必须在定义的事务边界内完成。客户端只有在业务缓存、descriptor、加密 Archive 和 cursor 都可靠落盘后才 ACK。"
  ),
  html("user_flow_diagram", userFlowDiagram),
  md(
    "closed_loop_detail",
    "### Precise closed-loop logic\n\n1. Web/iOS/Desktop 从允许 stale-while-revalidate 的账户隔离缓存启动；安全、权限、Session 与权益节点必须回源验证。\n2. Chat Token 继续走专用 SSE；附件走 staging→checksum→AES-GCM→ready object；历史页只读取引用。\n3. Mutation 使用 mutationId、Idempotency-Key、baseVersion 与 changedPaths；receipt lease 防止重复副作用。\n4. Domain row、stateVersion/hash 和 Outbox 同事务提交；Auth DB 跨库变化使用 session revision fingerprint 和周期对账恢复漏发。\n5. WS 负责低延迟提示，SSE/Push/启动校验/定时 Hash/领域 ETag 形成副链路。\n6. 客户端 25ms/100 条微批去重，只补拉最高版本；失败不推进 cursor，恢复后幂等重放。\n7. 同字段冲突进入冲突中心；不同字段可自动 rebase；已读 cursor 只前进。"
  ),
  md(
    "sync_heading",
    "## Synchronization Architecture — 状态一致性校验与实时消息传输明确分离\n\n状态树回答“哪些权威节点变化了、我是否持有一致内容”；WS/SSE/APNs 回答“尽快告诉我可能有变化”。因此一个通知丢失不会导致永久不一致，一个实时连接也不能替代版本比较、cursor replay 和 Hash 修复。"
  ),
  html("sync_diagram", syncDiagram),
  {
    id: "sync_table",
    type: "table",
    tableId: "sync_model_matrix",
    layout: "full",
  },
  md(
    "sync_technology_decision",
    "### Merkle、CRDT 与 Event Sourcing 的当前决策\n\n- **Merkle Tree：暂不进入主链路。** 263 个节点的 manifest/batchGet 足以完成 O(变化节点数) 对账；只有状态树达到大规模分区且 manifest CPU/载荷成为实测瓶颈时，才在 workspace 子树试验 Merkle 摘要。\n- **CRDT：只为真正多写者协作正文预留。** 单账户跨设备配置使用 baseVersion + patch + 离线队列更可审计；草稿在出现同时编辑需求前不承担 CRDT 运维成本。\n- **Event Sourcing：按领域使用，不全面化。** Chat、安全审计、任务运行、解析/索引状态适合 append-only event/cursor；普通 Profile/Setting/Workspace 元数据仍以领域表为权威。Outbox 是可靠分发日志，不是第二套业务数据库。\n- **Vector Clock：普通节点不采用。** 服务端 stateVersion/逻辑时钟是最终权威；未来 peer-to-peer 或多主协作域再按需引入。"
  ),
  md(
    "agent_heading",
    "## AI Agent & Memory Architecture — 已具备 Personal AI OS 骨架，缺口主要在长期治理证明\n\nAthena 同时具备 Provider Registry、Agent 工具运行时、分层 Memory、Workspace Knowledge、Capability Broker、用量/预算与 Eval 数据模型。它已经超过“聊天壳”的架构形态；但 Personal AI OS 还要求可解释的记忆同意/遗忘、全 Provider 成本 enforcement、生产 eval corpus、插件强隔离和跨 Agent 的 durable delegation。"
  ),
  html("agent_diagram", agentDiagram),
  md(
    "memory_review",
    "### Memory architecture review\n\n- **Short-term Memory**：当前轮次、最近历史、工具状态；受上下文预算约束。\n- **Working Memory**：线程压缩摘要、当前计划、Workspace 情境；确定性压缩避免把失败推理固化。\n- **Long-term Memory**：候选→确认→结构化存储，支持跨设备同步与删除。\n- **User Profile Memory**：偏好、人格、账户上下文，与安全权限分离。\n- **Project Memory**：Workspace 文档、向量、知识图谱、活动与长期任务状态。\n\n五年目标不是把所有对话永久保存，而是把来源、同意、衰减、冲突、删除和 eval 都变成可验证策略。"
  ),
  md(
    "data_heading",
    "## Data Architecture — 领域表仍是事实，状态树、向量和对象存储各司其职\n\nEnterprise Data Architecture 的关键不是只有一个数据库，而是每类数据只有一个权威、生命周期可解释、恢复路径可执行。Athena 已为身份、业务、Blob、向量、图谱、Sync 和审计定义不同权威；PostgreSQL 云端演进不会把 Blob 搬回关系库，也不允许 Main 与 Auth 共享超级用户。"
  ),
  { id: "data_table", type: "table", tableId: "data_map", layout: "full" },
  md(
    "performance_heading",
    "## Performance — 最大收益来自删除错误的数据流，而不是单点微优化\n\n真实 Chat 数据外置使主库占用下降 **91.57%**；全账户暖启动请求下降 **72.41%**、业务载荷下降 **99.47%**；活跃账户暖启动载荷下降 **99.73%**。增量 Chat Hash Chain 在 10/100/1,000 条历史的稳健 p95 为 0.248/0.238/0.278ms，1,000 条相对 10 条仅增长 12.23%，没有线性退化。Web 初始入口保持 825,984 B raw / 234,701 B gzip。\n\n这些数值来自本机开发数据与隔离基准，证明算法和数据流方向；不代表生产网络、云数据库或模型 Provider 的端到端 p95。",
    "release_evidence"
  ),
  {
    id: "performance_chart_block",
    type: "chart",
    chartId: "performance_improvements",
    layout: "full",
  },
  md(
    "scale_heading",
    "## Scale Review — 1,000 用户前先离开 SQLite 热写，10,000 用户前必须验证分布式控制面\n\n容量模型假设 5% 用户同时在线、每个活跃用户每秒产生两个非 AI 控制请求。AI 流式连接、Token 速率和文件吞吐另行预算；因此图中数值只用于暴露拓扑瓶颈。100,000 用户场景必须做分区和多区域演练，不能用单机压测外推。"
  ),
  {
    id: "capacity_chart_block",
    type: "chart",
    chartId: "capacity_model",
    layout: "full",
  },
  {
    id: "scale_table_block",
    type: "table",
    tableId: "scale_matrix",
    layout: "full",
  },
  md(
    "security_heading",
    "## Security — Zero Trust 主链已形成，但高级密码学只在有威胁模型时使用\n\nAthena 把身份、Session、资源权限、工具能力、数据加密、审计完整性和运行隔离分成独立控制。AES-256-GCM 与 HKDF 解决机密性和域隔离；SHA-256 Hash Chain 与 Ed25519 checkpoint 解决审计篡改检测；Passkey/OPAQUE 改善登录安全。它没有为技术展示而引入通用 ZKP、Threshold Signature、Shamir 或应用层双棘轮。\n\n本轮真实运行审计发现并关闭了 Key Custody 的 P0 权威选择缺口：数据库 registry 继续作为写权威，Provider keyring 负责解析材料，canary 验证后只在进程内选择注册密钥；缺失或不可验证时仍 fail-closed。显式轮换激活同时更新进程内权威，避免长生命周期进程继续用旧密钥。修复没有生成、改写或轮换任何实际密钥。"
  ),
  {
    id: "security_table_block",
    type: "table",
    tableId: "security_matrix",
    layout: "full",
  },
  md(
    "security_combinations",
    "### Recommended cryptographic combinations\n\n- **HKDF + AEAD**：按领域/对象派生或封装密钥，AES-256-GCM 加密正文；已使用。\n- **Hash Chain + Ed25519 + immutable archive**：高风险审计和 Chat 完整性；已使用前两项，外部不可变归档需 staging。\n- **Digital Signature + Trust Chain**：设备/Passkey/插件服务身份逐步增强；不要把不可枚举 ID 当授权。\n- **Merkle + cursor**：仅在超大分区对账成为实测瓶颈时实验。\n- **CRDT + operation log**：仅用于真正多人协同正文；不应用于安全、账务、Session 或普通设置。\n- **Threshold/Shamir**：未来高价值企业托管密钥、灾备或多方审批场景评估；当前收益不足以覆盖运维复杂度。"
  ),
  md(
    "operations_heading",
    "## Self-Operation & Repair — 故障必须被检测、隔离、恢复并证明\n\n系统已经具有 Runtime Coordinator、Outbox/receipt lease、DLQ、Auth revision reconcile、Content Object staging/GC、Sync full reconcile、迁移 reverse-shadow 和 signed security ledger。大厂级下一步不是再加一个后台任务，而是把这些恢复动作映射到持久 SLO、告警、演练和负责人。"
  ),
  html("recovery_diagram", recoveryDiagram),
  md(
    "debt_heading",
    "## Technical Debt — 当前没有确认未关闭的本地 P0，但生产证据缺口仍是 High\n\n技术债不能被“代码已经存在”掩盖。外部 PostgreSQL/NATS/S3/OTel 多节点演练、Sync cohort、授权设备 E2E 和依赖 High 治理仍是发布到大规模云端前的主要门槛。七个 God File 与旧兼容链路属于可控 Medium，应在持续交付中逐步缩小。"
  ),
  {
    id: "debt_table_block",
    type: "table",
    tableId: "debt_map",
    layout: "full",
  },
  md(
    "roadmap_heading",
    "## Five-Year Evolution — 先建立企业级证明，再扩展为 Personal AI OS 和多 Agent 社会\n\n路线图坚持三个约束：业务领域表继续是权威；Sync V2 不成为企业总线；NATS/对象存储/向量系统不成为平行业务数据库。每一阶段只有在上一阶段 SLO、权限和回滚证据成熟后才扩大自治范围。"
  ),
  {
    id: "roadmap_table_block",
    type: "table",
    tableId: "roadmap",
    layout: "full",
  },
  md(
    "score_heading",
    "## Final Evaluation — 结构领先于运行规模证明，综合评分 8.1/10\n\n架构质量、AI Native 和未来扩展能力已经进入强区间；Scalability 与 Maintainability 被真实证据刻意压低：分布式运行尚未在外部 staging 完成，七个大 owner 仍影响评审和隔离。这个评分不应因增加更多技术名词而提高，只能通过长期 SLO、故障演练、客户规模和债务收敛提高。"
  ),
  {
    id: "score_chart_block",
    type: "chart",
    chartId: "architecture_scores",
    layout: "full",
  },
  {
    id: "score_table_block",
    type: "table",
    tableId: "score_detail",
    layout: "full",
  },
  md(
    "methodology",
    "## Methodology — 代码、真实数据、运行态与既有门禁交叉验证\n\n本评审扫描 Web、Server、Collector、iOS、Desktop、Prisma Main/PostgreSQL schemas、迁移、Docker/observability、CI 和架构文档；对当前开发 Main/Auth DB 执行只读 quick/FK 检查、Sync shadow audit、Content Object inventory、Chat payload dry-run 和 HTTP 探针；复用完整测试矩阵、Bundle、模块边界、数据访问、安全与供应链门禁结果。\n\n模块评价采用四个标准：单一权威、事务/一致性边界、失败可见性、可回滚演进。性能只引用有前后基线的指标。规模评价采用场景模型，不使用虚构吞吐。"
  ),
  md("architecture_risks_heading", "## Architecture Risks"),
  md(
    "limitations",
    "## Limitations, Uncertainty & Robustness\n\n- 本机没有 Docker CLI，也没有授权的外部 PostgreSQL、NATS、S3、KMS 或 SIEM，因此分布式结论停留在 schema/adapter/fault-test 级。\n- 真实数据样本是 4 用户、6 Workspace、72 Thread、1,038 Chat；足以验证迁移完整性，不代表企业租户分布。\n- Sync V2 当前环境 enabled=false；节点健康不等于生产用户已经采用。\n- Browser runtime audit 主要覆盖未登录与静态契约；授权多设备 E2E 是下一阶段 High。\n- AI Provider 的网络、价格和限额外生变化大；当前 ai_usage_events 样本为空，成本容量只做控制面判断。\n- 供应链 reachable Critical=0，但 raw High 仍存在，不能表述为“漏洞清零”。\n- 架构评分包含专家判断；评分变化应由新证据而不是措辞驱动。"
  ),
  md(
    "recommendations",
    "## Recommended Next Steps — 先把已建控制面变成可证明的运行能力\n\n1. 在 Docker-capable staging 部署 PostgreSQL Main/Auth、NATS JetStream、MinIO 和 OTel 栈，执行网络分区、消费者重启、池耗尽、checksum、CDC/cutover/reverse-shadow 故障矩阵。\n2. 保持 SQLite/local/memory 为当前权威，Sync V2 按 deterministic cohort 从 shadow→Web→iOS TestFlight→核心域，门禁 Hash mismatch <0.01%、full reconcile <1%、暖启动收益回退 <5%。\n3. 建立授权 Web/iOS/Desktop 多设备 E2E 租户，覆盖 kill/restart、跨网络、账号切换、权限撤销、离线冲突和 Push 丢失。\n4. 将 AI governance 从 observe 按领域进入 enforce；持续记录 token、cost、latency、quality、安全和工具正确性。\n5. 继续拆分七个 God File，优先 iOS Conversation/Workspace、Reader orchestration、Cognition batch 和 system route registrars；保持 no-growth 门禁。\n6. 依赖升级坚持 reachable Critical=0；High 必须有 owner、隔离、到期时间和回归，不使用 force 绕过测试。"
  ),
  md(
    "further_questions",
    "## Further Questions for the Architecture Committee\n\n- 首个云端目标是 1,000、10,000 还是多区域 100,000 用户？不同目标决定 PostgreSQL 分区、NATS subject 和 vector tenancy 的优先级。\n- 哪些记忆类别允许跨 Workspace、跨设备或跨组织复用？需要怎样的 consent、expiry 和可解释性？\n- 哪个协作域首先具备真正同时多写者需求，以证明 CRDT/OT 的投资？\n- 企业客户是否要求客户管理密钥、数据驻留、WORM 审计或多方密钥恢复？这些需求才决定 KMS、Threshold 或 Shamir 的必要性。\n- Multi-Agent 的价值主要来自自治执行、组织协作还是插件市场？必须先明确责任和成本边界，再设计协议。"
  ),
];

const artifact = {
  surface: "report",
  manifest: {
    version: 1,
    surface: "report",
    title:
      "Athena System Architecture Blueprint & Technical Due Diligence Report",
    description:
      "Enterprise-grade v2.3 architecture review for CTO and architecture committee decision making.",
    generatedAt,
    cards,
    charts,
    tables,
    sources,
    blocks,
  },
  snapshot: {
    version: 1,
    generatedAt,
    status: "ready",
    datasets: {
      headline: [
        {
          overallScore: 8.1,
          dbReduction: 0.9157,
          warmPayloadReduction: 0.9947,
          syncIntegrity: 1,
          testTotal: 1350 + 396 + 99 + 5,
          godFiles: 7,
        },
      ],
      technology: technologyRows,
      modules: moduleRows,
      data: dataRows,
      syncModels: syncRows,
      security: securityRows,
      scale: scaleRows,
      debt: debtRows,
      roadmap: roadmapRows,
      scores: scoreRows,
      performance: performanceRows,
    },
  },
  sources,
  package_info: {},
};

const artifactPath = path.join(
  outputDir,
  "athena-system-architecture-blueprint-v2.3.artifact.json"
);
fs.writeFileSync(
  artifactPath,
  `${JSON.stringify(artifact, null, 2)}\n`,
  "utf8"
);
console.log(
  JSON.stringify({ success: true, artifactPath, evidencePath }, null, 2)
);
