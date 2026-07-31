#!/usr/bin/env node
const crypto = require("crypto");
const Database = require("better-sqlite3");
const {
  assertDatabaseFile,
  bootstrapCliRuntime,
} = require("./lib/runtimeBootstrap");

const CONTROL_TABLES = new Set([
  "_prisma_migrations",
  "athena_migration_changes",
  "athena_migration_state",
]);

const TEXT_CAST_PARAMETER_TYPES = new Set([
  "bigint",
  "decimal",
  "double precision",
  "numeric",
  "real",
]);

function parseArgs(argv = process.argv.slice(2)) {
  const value = (name, fallback = null) => {
    const inline = argv.find((arg) => String(arg).startsWith(`--${name}=`));
    if (inline) return String(inline).slice(name.length + 3);
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  return {
    command: value("command", "plan"),
    database: value("database", "main"),
    batchSize: Math.max(1, Math.min(5_000, Number(value("batch-size", 500)))),
    afterSeq: Math.max(0, Number(value("after-seq", 0))),
    allowNonempty: argv.includes("--allow-nonempty"),
    execute: argv.includes("--execute"),
  };
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function sourceTables(db) {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((row) => String(row.name))
    .filter((name) => !CONTROL_TABLES.has(name));
}

function tableMetadata(db, table) {
  const columns = db
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all();
  const primaryKey = columns
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => String(column.name));
  return {
    table,
    columns: columns.map((column) => String(column.name)),
    primaryKey,
  };
}

function orderedTables(
  db,
  tables = sourceTables(db),
  additionalParents = new Map()
) {
  const remaining = new Set(tables);
  const ordered = [];
  while (remaining.size) {
    let progressed = false;
    for (const table of [...remaining].sort()) {
      const parents = new Set(
        db
        .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`)
        .all()
        .map((row) => String(row.table))
      );
      for (const parent of additionalParents.get(table) || [])
        parents.add(parent);
      if ([...parents].some((parent) => remaining.has(parent))) continue;
      ordered.push(table);
      remaining.delete(table);
      progressed = true;
    }
    if (!progressed) {
      ordered.push(...[...remaining].sort());
      break;
    }
  }
  return ordered;
}

function cdcTriggerName(table, operation) {
  const digest = crypto
    .createHash("sha256")
    .update(`${table}:${operation}`)
    .digest("hex")
    .slice(0, 16);
  return `athena_cdc_${operation}_${digest}`;
}

function jsonObjectExpression(prefix, primaryKey) {
  return `json_object(${primaryKey
    .flatMap((column) => [
      `'${String(column).replace(/'/g, "''")}'`,
      `${prefix}.${quoteIdentifier(column)}`,
    ])
    .join(", ")})`;
}

function installCdc(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS athena_migration_changes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      tableName TEXT NOT NULL,
      operation TEXT NOT NULL,
      pkJson TEXT NOT NULL,
      changedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS athena_migration_changes_table_seq_idx
      ON athena_migration_changes(tableName, seq);
    CREATE TABLE IF NOT EXISTS athena_migration_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
  for (const table of CONTROL_TABLES) {
    for (const operation of ["insert", "update", "delete"]) {
      db.exec(
        `DROP TRIGGER IF EXISTS ${quoteIdentifier(
          cdcTriggerName(table, operation)
        )}`
      );
    }
  }
  let installed = 0;
  for (const table of sourceTables(db)) {
    const { primaryKey } = tableMetadata(db, table);
    if (!primaryKey.length) continue;
    for (const operation of ["insert", "update", "delete"]) {
      const trigger = cdcTriggerName(table, operation);
      const prefix = operation === "delete" ? "OLD" : "NEW";
      db.exec(`
        DROP TRIGGER IF EXISTS ${quoteIdentifier(trigger)};
        CREATE TRIGGER ${quoteIdentifier(trigger)} AFTER ${operation.toUpperCase()}
        ON ${quoteIdentifier(table)} BEGIN
          INSERT INTO athena_migration_changes(tableName, operation, pkJson)
          VALUES (
            '${table.replace(/'/g, "''")}',
            '${operation}',
            ${jsonObjectExpression(prefix, primaryKey)}
          );
        END;
      `);
      installed += 1;
    }
  }
  return installed;
}

async function targetMetadata(client) {
  const rows = await client.$queryRawUnsafe(`
    SELECT table_name, column_name, data_type, ordinal_position
    FROM information_schema.columns
    WHERE table_schema = current_schema()
    ORDER BY table_name, ordinal_position
  `);
  const tables = new Map();
  for (const row of rows) {
    const table = String(row.table_name);
    if (!tables.has(table)) tables.set(table, new Map());
    tables.get(table).set(String(row.column_name), String(row.data_type));
  }
  return tables;
}

async function targetParentDependencies(client) {
  const rows = await client.$queryRawUnsafe(`
    SELECT child.relname AS table_name, parent.relname AS parent_table_name
    FROM pg_constraint constraint_row
    JOIN pg_class child ON child.oid = constraint_row.conrelid
    JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = constraint_row.confrelid
    JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
    WHERE constraint_row.contype = 'f'
      AND child_namespace.nspname = current_schema()
      AND parent_namespace.nspname = current_schema()
    ORDER BY child.relname, parent.relname
  `);
  const dependencies = new Map();
  for (const row of rows) {
    const table = String(row.table_name);
    if (!dependencies.has(table)) dependencies.set(table, new Set());
    dependencies.get(table).add(String(row.parent_table_name));
  }
  return dependencies;
}

function convertValue(value, dataType) {
  if (value === null || value === undefined) return null;
  if (dataType === "boolean") return Boolean(Number(value));
  if (
    ["timestamp without time zone", "timestamp with time zone"].includes(
      dataType
    )
  )
    return value instanceof Date ? value : new Date(value);
  if (dataType === "bytea" && !(value instanceof Buffer))
    return Buffer.from(value);
  if (["double precision", "real"].includes(dataType)) return Number(value);
  if (["decimal", "numeric"].includes(dataType)) return String(value);
  if (dataType === "bigint") return BigInt(value);
  return value;
}

function bindValue(value, dataType) {
  const converted = convertValue(value, dataType);
  if (converted === null || converted === undefined) return converted;
  // Prisma selects the PostgreSQL binary representation for a JavaScript
  // number from its runtime value. Integer-valued SQLite REALs (for example
  // 1.0) can consequently be encoded as integers while PostgreSQL expects a
  // float8 parameter. Bind numeric families as text and cast them explicitly
  // in SQL so values keep their exact meaning without binary OID ambiguity.
  if (TEXT_CAST_PARAMETER_TYPES.has(dataType)) return String(converted);
  return converted;
}

function parameterExpression(index, dataType) {
  const parameter = `$${index + 1}`;
  if (!TEXT_CAST_PARAMETER_TYPES.has(dataType)) return parameter;
  return `${parameter}::text::${dataType}`;
}

function upsertStatement(metadata, targetColumns) {
  const columns = metadata.columns.filter((column) =>
    targetColumns.has(column)
  );
  const primaryKey = metadata.primaryKey.filter((column) =>
    columns.includes(column)
  );
  if (!columns.length || !primaryKey.length) return null;
  const values = columns
    .map((column, index) =>
      parameterExpression(index, targetColumns.get(column))
    )
    .join(", ");
  const updates = columns
    .filter((column) => !primaryKey.includes(column))
    .map(
      (column) =>
        `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`
    )
    .join(", ");
  return {
    columns,
    sql: `INSERT INTO ${quoteIdentifier(metadata.table)} (${columns
      .map(quoteIdentifier)
      .join(", ")}) VALUES (${values}) ON CONFLICT (${primaryKey
      .map(quoteIdentifier)
      .join(", ")}) ${updates ? `DO UPDATE SET ${updates}` : "DO NOTHING"}`,
  };
}

async function copyRows({ client, metadata, targetColumns, rows }) {
  const statement = upsertStatement(metadata, targetColumns);
  if (!statement) return 0;
  let copied = 0;
  for (const row of rows) {
    const values = statement.columns.map((column) =>
      bindValue(row[column], targetColumns.get(column))
    );
    try {
      await client.$executeRawUnsafe(statement.sql, ...values);
    } catch (error) {
      error.code = `POSTGRESQL_COPY_FAILED:${metadata.table}`;
      throw error;
    }
    copied += 1;
  }
  return copied;
}

function canonicalValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  return value;
}

function chunkHash(rows, columns, dataTypes = null) {
  const hash = crypto.createHash("sha256");
  for (const row of rows) {
    const normalized = {};
    for (const column of columns) {
      const value = dataTypes
        ? convertValue(row[column], dataTypes.get(column))
        : row[column];
      normalized[column] = canonicalValue(value);
    }
    hash.update(JSON.stringify(normalized));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function differingColumns(sourceRows, targetRows, columns, dataTypes) {
  const differing = new Set();
  const rowCount = Math.max(sourceRows.length, targetRows.length);
  for (let index = 0; index < rowCount; index += 1) {
    const source = sourceRows[index] || {};
    const target = targetRows[index] || {};
    for (const column of columns) {
      const sourceValue = canonicalValue(
        convertValue(source[column], dataTypes.get(column))
      );
      const targetValue = canonicalValue(target[column]);
      if (JSON.stringify(sourceValue) !== JSON.stringify(targetValue))
        differing.add(column);
    }
  }
  return [...differing].sort();
}

async function ensureEmptyTarget(client, tables, allowNonempty) {
  if (allowNonempty) return;
  for (const table of tables) {
    const rows = await client.$queryRawUnsafe(
      `SELECT COUNT(*)::bigint AS count FROM ${quoteIdentifier(table)}`
    );
    if (BigInt(rows[0]?.count || 0) > 0n) {
      const error = new Error(`postgresql_target_not_empty:${table}`);
      error.code = "POSTGRESQL_TARGET_NOT_EMPTY";
      throw error;
    }
  }
}

async function snapshot({ db, client, batchSize, allowNonempty }) {
  const targets = await targetMetadata(client);
  const targetParents = await targetParentDependencies(client);
  const tables = orderedTables(db, sourceTables(db), targetParents).filter(
    (table) => targets.has(table)
  );
  await ensureEmptyTarget(client, tables, allowNonempty);
  const startSeq = Number(
    db
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) AS seq FROM athena_migration_changes"
      )
      .get()?.seq || 0
  );
  const summary = { startSeq, tables: 0, rows: 0 };
  db.exec("BEGIN");
  try {
    for (const table of tables) {
      const metadata = tableMetadata(db, table);
      const order = metadata.primaryKey.length
        ? ` ORDER BY ${metadata.primaryKey.map(quoteIdentifier).join(", ")}`
        : "";
      let offset = 0;
      while (true) {
        const rows = db
          .prepare(
            `SELECT * FROM ${quoteIdentifier(table)}${order} LIMIT ? OFFSET ?`
          )
          .all(batchSize, offset);
        if (!rows.length) break;
        summary.rows += await copyRows({
          client,
          metadata,
          targetColumns: targets.get(table),
          rows,
        });
        offset += rows.length;
      }
      summary.tables += 1;
    }
  } finally {
    db.exec("ROLLBACK");
  }
  return summary;
}

function sourceRowByPrimaryKey(db, metadata, primaryKey) {
  const where = metadata.primaryKey
    .map((column) => `${quoteIdentifier(column)} = ?`)
    .join(" AND ");
  return db
    .prepare(`SELECT * FROM ${quoteIdentifier(metadata.table)} WHERE ${where}`)
    .get(...metadata.primaryKey.map((column) => primaryKey[column]));
}

async function deleteTargetRow(client, metadata, primaryKey) {
  const where = metadata.primaryKey
    .map((column, index) => `${quoteIdentifier(column)} = $${index + 1}`)
    .join(" AND ");
  await client.$executeRawUnsafe(
    `DELETE FROM ${quoteIdentifier(metadata.table)} WHERE ${where}`,
    ...metadata.primaryKey.map((column) => primaryKey[column])
  );
}

async function catchUp({ db, client, afterSeq, batchSize }) {
  const targets = await targetMetadata(client);
  let cursor = afterSeq;
  let applied = 0;
  while (true) {
    const changes = db
      .prepare(
        "SELECT seq, tableName, operation, pkJson FROM athena_migration_changes WHERE seq > ? ORDER BY seq LIMIT ?"
      )
      .all(cursor, batchSize);
    if (!changes.length) break;
    for (const change of changes) {
      const table = String(change.tableName);
      if (!targets.has(table)) {
        cursor = Number(change.seq);
        continue;
      }
      const metadata = tableMetadata(db, table);
      const primaryKey = JSON.parse(change.pkJson);
      const row = sourceRowByPrimaryKey(db, metadata, primaryKey);
      if (change.operation === "delete" || !row) {
        await deleteTargetRow(client, metadata, primaryKey);
      } else {
        await copyRows({
          client,
          metadata,
          targetColumns: targets.get(table),
          rows: [row],
        });
      }
      cursor = Number(change.seq);
      applied += 1;
    }
  }
  const checkpoint = Number(
    db
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) AS seq FROM athena_migration_changes"
      )
      .get()?.seq || 0
  );
  return {
    afterSeq,
    appliedSeq: cursor,
    checkpoint,
    applied,
    caughtUp: cursor >= checkpoint,
  };
}

async function verify({ db, client, batchSize }) {
  const targets = await targetMetadata(client);
  const mismatches = [];
  let checkedTables = 0;
  let checkedRows = 0;
  for (const table of orderedTables(db).filter((name) => targets.has(name))) {
    const metadata = tableMetadata(db, table);
    if (!metadata.primaryKey.length) continue;
    const columns = metadata.columns.filter((column) =>
      targets.get(table).has(column)
    );
    const order = metadata.primaryKey.map(quoteIdentifier).join(", ");
    const sourceCount = Number(
      db
        .prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`)
        .get().count
    );
    const targetCountRows = await client.$queryRawUnsafe(
      `SELECT COUNT(*)::bigint AS count FROM ${quoteIdentifier(table)}`
    );
    const targetCount = Number(targetCountRows[0]?.count || 0);
    if (sourceCount !== targetCount) {
      mismatches.push({ table, type: "row_count", sourceCount, targetCount });
      continue;
    }
    for (let offset = 0; offset < sourceCount; offset += batchSize) {
      const sourceRows = db
        .prepare(
          `SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(
            table
          )} ORDER BY ${order} LIMIT ? OFFSET ?`
        )
        .all(batchSize, offset);
      const targetRows = await client.$queryRawUnsafe(
        `SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(
          table
        )} ORDER BY ${order} LIMIT $1 OFFSET $2`,
        batchSize,
        offset
      );
      const sourceHash = chunkHash(sourceRows, columns, targets.get(table));
      const targetHash = chunkHash(targetRows, columns, targets.get(table));
      if (sourceHash !== targetHash) {
        mismatches.push({
          table,
          type: "chunk_hash",
          offset,
          sourceHash,
          targetHash,
          differingColumns: differingColumns(
            sourceRows,
            targetRows,
            columns,
            targets.get(table)
          ),
        });
        break;
      }
      checkedRows += sourceRows.length;
    }
    checkedTables += 1;
  }
  return {
    checkedTables,
    checkedRows,
    mismatches,
    valid: mismatches.length === 0,
  };
}

async function migrationPlan(db) {
  const tables = orderedTables(db);
  let rows = 0;
  const details = tables.map((table) => {
    const count = Number(
      db
        .prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`)
        .get().count
    );
    rows += count;
    return {
      table,
      rows: count,
      primaryKey: tableMetadata(db, table).primaryKey,
    };
  });
  return { tables: details.length, rows, details };
}

async function main() {
  const options = parseArgs();
  if (!["main", "auth"].includes(options.database)) {
    throw Object.assign(new Error("migration_database_target_invalid"), {
      code: "MIGRATION_DATABASE_TARGET_INVALID",
    });
  }
  const writeCommands = new Set(["install-cdc", "snapshot", "catch-up"]);
  const writes = writeCommands.has(options.command);
  const runtime = await bootstrapCliRuntime({
    access: writes ? "write" : "read",
    execute: options.execute,
    database: options.database,
    requireExistingDatabase: false,
  });
  if (runtime.databaseProvider !== "postgresql") {
    throw Object.assign(new Error("postgresql_provider_required"), {
      code: "POSTGRESQL_PROVIDER_REQUIRED",
    });
  }
  const sourcePath =
    options.database === "auth"
      ? runtime.sqliteAuthSourceDatabasePath
      : runtime.sqliteSourceDatabasePath;
  assertDatabaseFile(sourcePath, `${options.database}-sqlite-source`);
  const db = new Database(sourcePath, {
    readonly: !["install-cdc"].includes(options.command),
    fileMustExist: true,
  });
  const clientModule =
    options.database === "auth"
      ? require("../generated/postgresql-auth")
      : require("../generated/postgresql-main");
  const databaseUrl = writes
    ? options.database === "auth"
      ? runtime.authMigrationDatabaseUrl
      : runtime.mainMigrationDatabaseUrl
    : options.database === "auth"
      ? runtime.authDatabaseUrl
      : runtime.mainDatabaseUrl;
  if (!databaseUrl) {
    throw Object.assign(new Error("postgresql_migration_role_required"), {
      code: "POSTGRESQL_MIGRATION_ROLE_REQUIRED",
    });
  }
  const client = new clientModule.PrismaClient({
    log: ["error"],
    datasources: { db: { url: databaseUrl } },
  });
  try {
    let result;
    switch (options.command) {
      case "plan":
        result = await migrationPlan(db);
        break;
      case "install-cdc":
        result = { installedTriggers: installCdc(db) };
        break;
      case "snapshot":
        result = await snapshot({ db, client, ...options });
        break;
      case "catch-up":
        result = await catchUp({ db, client, ...options });
        break;
      case "verify":
        result = await verify({ db, client, ...options });
        break;
      default:
        throw Object.assign(new Error("migration_command_invalid"), {
          code: "MIGRATION_COMMAND_INVALID",
        });
    }
    console.log(
      JSON.stringify(
        { success: true, command: options.command, result },
        null,
        2
      )
    );
    if (result?.valid === false || result?.caughtUp === false)
      process.exitCode = 2;
  } finally {
    db.close();
    await client.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      `[sqlite-postgresql-migration] ${error.code || error.message}`
    );
    process.exitCode = 1;
  });
}

module.exports = {
  catchUp,
  bindValue,
  cdcTriggerName,
  chunkHash,
  convertValue,
  differingColumns,
  installCdc,
  orderedTables,
  parseArgs,
  parameterExpression,
  quoteIdentifier,
  sourceTables,
  tableMetadata,
  targetParentDependencies,
  upsertStatement,
};
