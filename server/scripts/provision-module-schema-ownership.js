#!/usr/bin/env node
const crypto = require("crypto");
const {
  migrationPostgresqlUrl,
} = require("../utils/database/databaseProvider");
const {
  ownershipRegistry,
  roleRegistry,
} = require("../utils/database/moduleSchemaOwnership");

function argument(name, fallback = null) {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function fingerprint(entries) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
}

async function existingTables(client) {
  const result = await client.query(`
    SELECT tablename
      FROM pg_catalog.pg_tables
     WHERE schemaname = 'public'
       AND tablename <> '_prisma_migrations'
     ORDER BY tablename
  `);
  return result.rows.map((row) => row.tablename);
}

async function applyOwnership({ client, database, registry, roles }) {
  await client.query("BEGIN");
  try {
    const tables = new Set(await existingTables(client));
    const covered = registry.filter(({ table }) => tables.has(table));
    const missing = [...tables].filter(
      (table) => !registry.some((entry) => entry.table === table)
    );
    if (missing.length)
      throw new Error(`module_schema_unowned_tables:${missing.join(",")}`);

    const observer =
      database === "auth" ? "athena_auth_observer" : "athena_main_observer";
    for (const role of [...Object.values(roles), observer]) {
      await client.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(role)}`);
      await client.query(
        `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM ${quoteIdentifier(role)}`
      );
      await client.query(
        `REVOKE USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA public FROM ${quoteIdentifier(role)}`
      );
      await client.query(
        `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${quoteIdentifier(role)}`
      );
    }

    for (const { table, schema } of covered) {
      const role = roles[schema];
      if (!role) throw new Error(`module_schema_role_missing:${schema}`);
      const target = `public.${quoteIdentifier(table)}`;
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${target} TO ${quoteIdentifier(role)}`
      );
      const sequences = await client.query(
        `SELECT pg_get_serial_sequence($1, column_name) AS sequence_name
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $2`,
        [`public.${quoteIdentifier(table)}`, table]
      );
      for (const row of sequences.rows) {
        if (!row.sequence_name) continue;
        await client.query(
          `GRANT USAGE, SELECT ON SEQUENCE ${row.sequence_name} TO ${quoteIdentifier(role)}`
        );
      }
    }

    await client.query("COMMIT");
    return { database, tables: tables.size, covered: covered.length };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const database = argument("database", "main");
  if (!["main", "auth"].includes(database))
    throw new Error("module_schema_database_invalid");
  const apply = process.argv.includes("--apply");
  const execute = process.argv.includes("--execute");
  const registry = ownershipRegistry({ database });
  const roles = roleRegistry(database);
  const summary = {
    success: true,
    mode: apply && execute ? "applied" : "dry-run",
    database,
    schemas: Object.keys(roles).length,
    registryTables: registry.length,
    ownershipFingerprint: fingerprint(registry),
  };
  if (!apply || !execute) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  if (process.env.ATHENA_DATABASE_PROVIDER !== "postgresql")
    throw new Error("postgresql_provider_required");
  const { Client } = require("pg");
  const client = new Client({
    connectionString: migrationPostgresqlUrl(database),
  });
  await client.connect();
  try {
    Object.assign(
      summary,
      await applyOwnership({ client, database, registry, roles })
    );
  } finally {
    await client.end();
  }
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      JSON.stringify({ success: false, error: error.code || error.message })
    );
    process.exitCode = 1;
  });
}

module.exports = { applyOwnership, existingTables, fingerprint };
