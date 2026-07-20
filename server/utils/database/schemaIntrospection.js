const { isPostgresql } = require("./databaseProvider");

function normalizedIdentifiers(values = []) {
  const identifiers = [...new Set(values.map((value) => String(value || "")))];
  for (const identifier of identifiers) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
      const error = new Error("database_schema_identifier_invalid");
      error.code = "DATABASE_SCHEMA_IDENTIFIER_INVALID";
      throw error;
    }
  }
  return identifiers;
}

function placeholders(values = []) {
  return values.map(() => "?").join(", ");
}

async function existingTableNames(client, tableNames = [], env = process.env) {
  const requested = normalizedIdentifiers(tableNames);
  if (!requested.length) return new Set();
  const rows = isPostgresql(env)
    ? await client.$queryRawUnsafe(
        `SELECT table_name AS name
         FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND table_name IN (${placeholders(requested)})`,
        ...requested
      )
    : await client.$queryRawUnsafe(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND name IN (${placeholders(requested)})`,
        ...requested
      );
  return new Set(rows.map((row) => String(row.name || row.table_name || "")));
}

async function databaseTablesReady(client, tableNames = [], env = process.env) {
  const requested = normalizedIdentifiers(tableNames);
  const existing = await existingTableNames(client, requested, env);
  return requested.every((name) => existing.has(name));
}

async function ensureMigrationOwnedTables(
  client,
  tableNames = [],
  { context = "runtime", env = process.env } = {}
) {
  if (!isPostgresql(env)) return false;
  const requested = normalizedIdentifiers(tableNames);
  const existing = await existingTableNames(client, requested, env);
  const missing = requested.filter((name) => !existing.has(name));
  if (missing.length) {
    const error = new Error("database_schema_migration_required");
    error.code = "DATABASE_SCHEMA_MIGRATION_REQUIRED";
    error.context = String(context || "runtime").slice(0, 120);
    error.missingTables = missing;
    throw error;
  }
  return true;
}

async function databaseTableColumns(client, tableName, env = process.env) {
  const [normalized] = normalizedIdentifiers([tableName]);
  const rows = isPostgresql(env)
    ? await client.$queryRawUnsafe(
        `SELECT column_name AS name
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = ?`,
        normalized
      )
    : await client.$queryRawUnsafe(`PRAGMA table_info("${normalized}")`);
  return new Set(rows.map((row) => String(row.name || row.column_name || "")));
}

module.exports = {
  databaseTableColumns,
  databaseTablesReady,
  ensureMigrationOwnedTables,
  existingTableNames,
  normalizedIdentifiers,
};
