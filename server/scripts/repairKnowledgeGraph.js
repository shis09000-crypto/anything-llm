#!/usr/bin/env node
process.env.NODE_ENV === "development"
  ? require("dotenv").config({ path: `.env.${process.env.NODE_ENV}` })
  : require("dotenv").config();

const { repairKnowledgeGraph } = require("../utils/knowledgeGraph/repair");

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
