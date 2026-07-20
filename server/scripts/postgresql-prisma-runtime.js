#!/usr/bin/env node
const { spawnSync } = require("child_process");
const path = require("path");
const {
  bootstrapCliRuntime,
  stripRuntimeArguments,
} = require("./lib/runtimeBootstrap");

const serverRoot = path.resolve(__dirname, "..");

function databaseArgument(args = []) {
  const inline = args.find((arg) => String(arg).startsWith("--database="));
  if (inline) return String(inline).slice("--database=".length);
  const index = args.indexOf("--database");
  return index >= 0 ? args[index + 1] : "main";
}

function stripDatabaseArgument(args = []) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index] || "");
    if (value.startsWith("--database=")) continue;
    if (value === "--database") {
      index += 1;
      continue;
    }
    result.push(args[index]);
  }
  return result;
}

function mutatingCommand(args = []) {
  const [group, command] = args;
  return (
    (group === "migrate" && ["deploy", "resolve"].includes(command)) ||
    (group === "db" && ["execute", "push"].includes(command))
  );
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const database = databaseArgument(rawArgs);
  if (!["main", "auth"].includes(database)) {
    throw Object.assign(new Error("postgresql_database_target_invalid"), {
      code: "POSTGRESQL_DATABASE_TARGET_INVALID",
    });
  }
  const commandArgs = stripDatabaseArgument(stripRuntimeArguments(rawArgs));
  if (!commandArgs.length) {
    throw Object.assign(new Error("postgresql_prisma_command_required"), {
      code: "POSTGRESQL_PRISMA_COMMAND_REQUIRED",
    });
  }
  const write = mutatingCommand(commandArgs);
  const runtime = await bootstrapCliRuntime({
    access: write ? "write" : "read",
    execute: rawArgs.includes("--execute"),
    argv: rawArgs,
    database,
    requireExistingDatabase: !(
      commandArgs[0] === "migrate" && commandArgs[1] === "deploy"
    ),
    requiredTables:
      commandArgs[0] === "migrate" && commandArgs[1] === "status"
        ? ["_prisma_migrations"]
        : [],
  });
  if (runtime.databaseProvider !== "postgresql") {
    throw Object.assign(new Error("postgresql_provider_required"), {
      code: "POSTGRESQL_PROVIDER_REQUIRED",
    });
  }
  const databaseUrl = write
    ? database === "auth"
      ? runtime.authMigrationDatabaseUrl
      : runtime.mainMigrationDatabaseUrl
    : database === "auth"
      ? runtime.authDatabaseUrl
      : runtime.mainDatabaseUrl;
  if (!databaseUrl) {
    throw Object.assign(new Error("postgresql_migration_role_required"), {
      code: "POSTGRESQL_MIGRATION_ROLE_REQUIRED",
    });
  }
  const finalArgs = commandArgs.some(
    (arg) => arg === "--schema" || String(arg).startsWith("--schema=")
  )
    ? commandArgs
    : [...commandArgs, "--schema=./prisma/postgresql/schema.prisma"];
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(command, ["prisma", ...finalArgs], {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl, CHECKPOINT_DISABLE: "1" },
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[postgresql-prisma-runtime] ${error.code || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  databaseArgument,
  main,
  mutatingCommand,
  stripDatabaseArgument,
};
