#!/usr/bin/env node
const { spawnSync } = require("child_process");
const path = require("path");
const {
  bootstrapCliRuntime,
  stripRuntimeArguments,
} = require("./lib/runtimeBootstrap");

const serverRoot = path.resolve(__dirname, "..");

function mutatingPrismaCommand(args = []) {
  const [group, command] = args;
  if (group === "migrate")
    return ["deploy", "dev", "reset", "resolve"].includes(command);
  if (group === "db") return ["push", "seed", "execute"].includes(command);
  return false;
}

function commandNeedsExistingDatabase(args = []) {
  const [group, command] = args;
  if (["generate", "validate", "format", "version"].includes(group))
    return false;
  if (group === "migrate" && ["deploy", "dev", "reset"].includes(command))
    return false;
  return true;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0) {
    console.error(
      "Usage: node scripts/prisma-runtime.js [--env development|production] [--execute] <prisma command...>\n" +
        "Example: node scripts/prisma-runtime.js --env development migrate status"
    );
    process.exitCode = 1;
    return;
  }
  const commandArgs = stripRuntimeArguments(rawArgs);
  const write = mutatingPrismaCommand(commandArgs);
  const execute = rawArgs.includes("--execute");
  const needsExisting = commandNeedsExistingDatabase(commandArgs);
  const runtime = await bootstrapCliRuntime({
    access: write ? "write" : "read",
    execute: write ? execute : false,
    argv: rawArgs,
    requireExistingDatabase: needsExisting,
    requiredTables: needsExisting ? ["_prisma_migrations"] : [],
  });

  const datasourceUrl = new URL(`file:${runtime.databasePath}`);
  datasourceUrl.searchParams.set("connection_limit", "1");
  datasourceUrl.searchParams.set("pool_timeout", "10");
  const env = {
    ...process.env,
    DATABASE_URL: datasourceUrl.toString(),
    CHECKPOINT_DISABLE: "1",
  };
  const finalArgs = commandArgs.some(
    (arg) => arg === "--schema" || arg.startsWith("--schema=")
  )
    ? commandArgs
    : [...commandArgs, "--schema=./prisma/schema.prisma"];
  console.log(`[prisma-runtime] DATABASE_URL=${env.DATABASE_URL}`);
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(command, ["prisma", ...finalArgs], {
    cwd: serverRoot,
    env,
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[prisma-runtime] ${error.code || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { commandNeedsExistingDatabase, main, mutatingPrismaCommand };
