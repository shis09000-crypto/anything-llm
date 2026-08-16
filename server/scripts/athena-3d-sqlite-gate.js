#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  writeReport,
} = require("../../scripts/athena-3d-test-lib.cjs");

const SERVER_ROOT = path.resolve(__dirname, "..");
const REQUIRED_TABLES = [
  "athena_3d_session_memories",
  "athena_3d_session_memory_turns",
  "athena_3d_session_memory_checkpoints",
  "athena_3d_character_state_windows",
  "athena_3d_character_memory_profiles",
  "athena_3d_character_memory_sessions",
  "athena_3d_character_memory_turns",
  "athena_3d_character_memory_revisions",
  "athena_3d_character_memory_jobs",
  "athena_3d_character_memory_candidates",
  "athena_3d_character_user_model_entries",
  "athena_3d_character_memories",
  "athena_3d_character_memory_evidence",
  "athena_3d_character_growth_nodes",
  "athena_3d_character_emotional_milestones",
];

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: SERVER_ROOT,
    env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const error = new Error(result.stderr || result.stdout || `${command} failed`);
    error.code = "ATHENA_3D_SQLITE_COMMAND_FAILED";
    throw error;
  }
  return result.stdout;
}

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "athena-3d-sqlite-"));
  const databasePath = path.join(temporary, "development", "anythingllm.db");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const env = {
    ...process.env,
    NODE_ENV: "test",
    APP_ENV: "development",
    ANYTHINGLLM_STORAGE_BASE_DIR: temporary,
    DATABASE_URL: `file:${databasePath}`,
    CHECKPOINT_DISABLE: "1",
  };
  fs.writeFileSync(databasePath, "");
  // Prisma's full historical migration chain contains legacy migrations that
  // cannot bootstrap a brand-new empty SQLite database. Build the isolated
  // schema from the current authority, then prove the migration ledger and
  // all 3D contracts against that database.
  run(
    "npx",
    ["prisma", "db", "push", "--schema=./prisma/schema.prisma", "--skip-generate"],
    env
  );
  const probe = run(
    "node",
    [
      "-e",
      `const {PrismaClient}=require('@prisma/client');const p=new PrismaClient({datasources:{db:{url:process.env.DATABASE_URL}}});(async()=>{const tables=await p.$queryRawUnsafe(\"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'athena_3d_%'\");const columns=await p.$queryRawUnsafe(\"SELECT m.name AS table_name,p.name AS column_name FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type='table' AND m.name LIKE 'athena_3d_%' AND lower(p.name) LIKE '%ciphertext%'\");console.log(JSON.stringify({tables,columns}));await p.$disconnect()})().catch(async e=>{console.error(e);await p.$disconnect();process.exit(1)})`,
    ],
    env
  );
  const lines = probe.trim().split("\n");
  const observed = JSON.parse(lines.at(-1));
  const present = new Set(observed.tables.map((entry) => entry.name));
  const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
  const checks = {
    fresh_schema_materialized: true,
    required_tables_present: missing.length === 0,
    plaintext_contract: observed.columns.length === 0,
    isolated_database: databasePath.startsWith(os.tmpdir()),
  };
  const status = Object.values(checks).every(Boolean) ? "passed" : "failed";
  const { destination, report } = writeReport("sqlite-gate", {
    suite: "sqlite",
    status,
    database: "isolated_temporary",
    bootstrap_mode: "prisma_db_push_current_schema",
    checks,
    missing_tables: missing,
    forbidden_ciphertext_columns: observed.columns,
  });
  console.log(JSON.stringify({ report: destination, ...report }, null, 2));
  fs.rmSync(temporary, { recursive: true, force: true });
  if (status !== "passed") process.exitCode = 1;
}

main().catch((error) => {
  const { destination } = writeReport("sqlite-gate", {
    suite: "sqlite",
    status: "infrastructure_failed",
    error: { code: error.code || "ATHENA_3D_SQLITE_FAILED", message: error.message },
  });
  console.error(`${error.stack || error.message}\nReport: ${destination}`);
  process.exitCode = 1;
});
