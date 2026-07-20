#!/usr/bin/env node
const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");
let prisma;

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
  if (!args.all && !args.workspace) {
    console.error(
      "Usage: node scripts/backfillKnowledgeGraph.js --workspace <slug> | --all [--limit 100] [--batch-size 25] [--retry] [--cleanup]"
    );
    process.exit(1);
  }
  const execute = args.execute === true;
  await bootstrapCliRuntime({
    access: execute ? "write" : "read",
    execute,
    requiredTables: ["workspaces", "KnowledgeNode", "GraphExtractionJob"],
  });
  if (!execute) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          action: "knowledge-graph-backfill",
          workspace: args.workspace || null,
          all: args.all === true,
          instruction:
            "Repeat with explicit APP_ENV or --env plus --execute to mutate.",
        },
        null,
        2
      )
    );
    return;
  }
  prisma = require("../utils/prisma");
  const { backfillKnowledgeGraph } = require("../utils/knowledgeGraph");

  const result = await backfillKnowledgeGraph({
    workspaceSlug: args.workspace || null,
    all: args.all === true,
    limit: args.limit ? Number(args.limit) : null,
    batchSize: args["batch-size"] ? Number(args["batch-size"]) : 25,
    retry: args.retry === true,
    cleanup: args.cleanup === true,
  });
  console.log("[KnowledgeGraph] backfill complete", result);
}

main()
  .catch((error) => {
    console.error("[KnowledgeGraph] backfill failed", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma?.$disconnect().catch(() => {});
  });
