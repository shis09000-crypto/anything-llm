#!/usr/bin/env node

const { spawnSync } = require("child_process");
const path = require("path");
const { Client } = require("pg");
const {
  requiredEnvironment,
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

function prisma(args) {
  const result = spawnSync("npx", ["prisma", ...args], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: process.env.ATHENA_3D_TEST_POSTGRES_URL,
      CHECKPOINT_DISABLE: "1",
    },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const error = new Error(result.stderr || result.stdout || "Prisma failed");
    error.code = "ATHENA_3D_POSTGRES_PRISMA_FAILED";
    throw error;
  }
  return result.stdout;
}

async function main() {
  requiredEnvironment(["ATHENA_3D_TEST_POSTGRES_URL"]);
  if (!/athena[_-]?3d[_-]?test/i.test(process.env.ATHENA_3D_TEST_POSTGRES_URL)) {
    const error = new Error(
      "ATHENA_3D_TEST_POSTGRES_URL must identify an isolated athena_3d_test database"
    );
    error.code = "ATHENA_3D_POSTGRES_DATABASE_NOT_ISOLATED";
    throw error;
  }
  prisma(["validate", "--schema=./prisma/postgresql/schema.prisma"]);
  if (process.env.ATHENA_3D_TEST_POSTGRES_APPLY_MIGRATIONS === "true")
    prisma(["migrate", "deploy", "--schema=./prisma/postgresql/schema.prisma"]);
  const client = new Client({ connectionString: process.env.ATHENA_3D_TEST_POSTGRES_URL });
  await client.connect();
  try {
    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
      [REQUIRED_TABLES]
    );
    const present = new Set(tables.rows.map((row) => row.table_name));
    const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
    const jsonColumns = await client.query(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name LIKE 'athena_3d_%' AND column_name ILIKE '%ciphertext%'`
    );
    const checks = {
      schema_valid: true,
      required_tables_present: missing.length === 0,
      plaintext_contract: jsonColumns.rows.length === 0,
      migration_history_present: (
        await client.query(`SELECT to_regclass('_prisma_migrations') AS table_name`)
      ).rows[0].table_name != null,
    };
    const status = Object.values(checks).every(Boolean) ? "passed" : "failed";
    const { destination, report } = writeReport("postgres-gate", {
      suite: "postgres",
      status,
      database: "isolated",
      migrations_applied:
        process.env.ATHENA_3D_TEST_POSTGRES_APPLY_MIGRATIONS === "true",
      checks,
      missing_tables: missing,
      forbidden_ciphertext_columns: jsonColumns.rows,
    });
    console.log(JSON.stringify({ report: destination, ...report }, null, 2));
    if (status !== "passed") process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  const { destination } = writeReport("postgres-gate", {
    suite: "postgres",
    status: "infrastructure_failed",
    error: {
      code: error.code || "ATHENA_3D_POSTGRES_FAILED",
      message: error.message,
      missing: error.missing || [],
    },
  });
  console.error(`${error.stack || error.message}\nReport: ${destination}`);
  process.exitCode = 1;
});
