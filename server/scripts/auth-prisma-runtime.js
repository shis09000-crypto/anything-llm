#!/usr/bin/env node
const { spawnSync } = require("child_process");
const path = require("path");

const serverRoot = path.resolve(__dirname, "..");
const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";

require("dotenv").config({ path: path.join(serverRoot, envPath) });

const { applyEnvironmentStorage, authDatabaseUrl } = require("../utils/environment");

applyEnvironmentStorage();

const env = {
  ...process.env,
  DATABASE_URL: authDatabaseUrl(),
  CHECKPOINT_DISABLE: "1",
};

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(
    "Usage: node scripts/auth-prisma-runtime.js <prisma command...>\n" +
      "Example: node scripts/auth-prisma-runtime.js migrate status"
  );
  process.exit(1);
}

const finalArgs = args.some(
  (arg) => arg === "--schema" || arg.startsWith("--schema=")
)
  ? args
  : [...args, "--schema=./prisma/schema.prisma"];

console.log(`[auth-prisma-runtime] DATABASE_URL=${env.DATABASE_URL}`);
const command = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(command, ["prisma", ...finalArgs], {
  cwd: serverRoot,
  env,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
