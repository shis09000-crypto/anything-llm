#!/usr/bin/env node

process.env.NODE_ENV === "development"
  ? require("dotenv").config({ path: `.env.${process.env.NODE_ENV}` })
  : require("dotenv").config();

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { DataAccessCenter } = require("../utils/dataAccess");
  const Workspace = DataAccessCenter.workspace;
  const KnowledgeGraph = DataAccessCenter.knowledgeGraph.model;
  const {
    recomputeNodeMetrics,
    recomputeStaleNodeMetrics,
  } = require("../utils/knowledgeGraph/nodeMetrics");

  if (!args.workspace && !args.all && !args.node) {
    console.error(
      "Usage: node scripts/recomputeKnowledgeNodeMetrics.js --workspace <slug> | --all | --node <nodeId> [--batch-size 50]"
    );
    process.exit(1);
  }

  if (args.node) {
    const node = await KnowledgeGraph.getNode(Number(args.node));
    if (!node) throw new Error("node_not_found");
    const result = await recomputeNodeMetrics({
      workspaceId: node.workspaceId,
      nodeId: node.id,
      trigger: "cli-node",
    });
    await KnowledgeGraph.createNodeMetricsRecomputeRun({
      workspaceId: node.workspaceId,
      trigger: "cli-node",
      batchSize: 1,
      processed: 1,
      succeeded: result ? 1 : 0,
      failed: result ? 0 : 1,
    });
    console.log("[KnowledgeNodeMetrics] node recompute complete", {
      nodeId: node.id,
      workspaceId: node.workspaceId,
      success: !!result,
    });
    return;
  }

  if (args.all) {
    const result = await recomputeStaleNodeMetrics({
      trigger: "cli-all",
      batchSize: Number(args["batch-size"] || 50),
    });
    console.log("[KnowledgeNodeMetrics] recompute complete", result);
    return;
  }

  const workspace = await Workspace.get({ slug: args.workspace });
  if (!workspace) throw new Error("workspace_not_found");
  await KnowledgeGraph.markWorkspaceNodeMetricsStale(
    workspace.id,
    "cli_workspace_recompute"
  );
  const result = await recomputeStaleNodeMetrics({
    workspaceId: workspace.id,
    trigger: "cli-workspace",
    batchSize: Number(args["batch-size"] || 50),
  });
  console.log("[KnowledgeNodeMetrics] workspace recompute complete", {
    workspace: workspace.slug,
    ...result,
  });
}

main()
  .catch((error) => {
    console.error("[KnowledgeNodeMetrics] recompute failed", error);
    process.exit(1);
  })
  .finally(async () => {
    const prisma = require("../utils/prisma");
    await prisma.$disconnect().catch(() => {});
  });
