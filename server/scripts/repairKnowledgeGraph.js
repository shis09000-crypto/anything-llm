#!/usr/bin/env node
const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");

function args() {
  const argv = process.argv.slice(2);
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : null;
  };
  return {
    workspaceSlug: value("--workspace"),
    all: argv.includes("--all"),
    allowReembed: argv.includes("--allow-reembed"),
    force: argv.includes("--force"),
    batchSize: value("--batch-size"),
    scanLimit: value("--scan-limit"),
    execute: argv.includes("--execute"),
  };
}

(async () => {
  try {
    const options = args();
    if (!options.workspaceSlug && !options.all) {
      console.error(
        "Usage: node scripts/repairKnowledgeGraph.js --workspace <slug> | --all [--batch-size 25] [--scan-limit 100] [--allow-reembed] [--force]"
      );
      process.exit(1);
    }
    await bootstrapCliRuntime({
      access: options.execute ? "write" : "read",
      execute: options.execute,
      requiredTables: [
        "workspaces",
        "KnowledgeNode",
        "KnowledgeGraphRepairRun",
        "_prisma_migrations",
      ],
    });
    if (!options.execute) {
      console.log(
        JSON.stringify(
          {
            success: true,
            mode: "dry-run",
            action: "would-repair-knowledge-graph",
            instruction: "Repair requires --execute and APP_ENV or --env.",
          },
          null,
          2
        )
      );
      process.exit(0);
    }
    const { repairKnowledgeGraph } = require("../utils/knowledgeGraph/repair");
    const result = await repairKnowledgeGraph({
      ...options,
      trigger: "cli",
    });
    console.log("[KnowledgeGraph] repair complete", result);
    process.exit(0);
  } catch (error) {
    console.error("[KnowledgeGraph] repair failed", error);
    process.exit(1);
  }
})();
