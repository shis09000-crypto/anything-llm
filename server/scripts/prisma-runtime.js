#!/usr/bin/env node
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const serverRoot = path.resolve(__dirname, "..");
const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";

require("dotenv").config({ path: path.join(serverRoot, envPath) });

const {
  applyEnvironmentStorage,
  databasePath,
} = require("../utils/environment");

applyEnvironmentStorage();
const dbPath = databasePath();
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const datasourceUrl = new URL(`file:${dbPath}`);
datasourceUrl.searchParams.set("connection_limit", "1");
datasourceUrl.searchParams.set("pool_timeout", "10");

const env = {
  ...process.env,
  DATABASE_URL: datasourceUrl.toString(),
  CHECKPOINT_DISABLE: "1",
};

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(
    "Usage: node scripts/prisma-runtime.js <prisma command...>\n" +
      "Example: node scripts/prisma-runtime.js migrate status"
  );
  process.exit(1);
}

const finalArgs = args.some(
  (arg) => arg === "--schema" || arg.startsWith("--schema=")
)
  ? args
  : [...args, "--schema=./prisma/schema.prisma"];

console.log(`[prisma-runtime] DATABASE_URL=${env.DATABASE_URL}`);
const command = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(command, ["prisma", ...finalArgs], {
  cwd: serverRoot,
  env,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
