const { isPostgresql } = require("./databaseProvider");

function postgresqlPlaceholders(sql) {
  const source = String(sql || "");
  let index = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let output = "";
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const current = source[cursor];
    const next = source[cursor + 1];
    if (lineComment) {
      output += current;
      if (current === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      output += current;
      if (current === "*" && next === "/") {
        output += next;
        cursor += 1;
        blockComment = false;
      }
      continue;
    }
    if (!quote && current === "-" && next === "-") {
      output += current + next;
      cursor += 1;
      lineComment = true;
      continue;
    }
    if (!quote && current === "/" && next === "*") {
      output += current + next;
      cursor += 1;
      blockComment = true;
      continue;
    }
    if (quote) {
      output += current;
      if (current === quote) {
        if (next === quote) {
          output += next;
          cursor += 1;
        } else quote = null;
      }
      continue;
    }
    if (["'", '"', "`"].includes(current)) {
      quote = current;
      output += current;
      continue;
    }
    if (current === "?") {
      index += 1;
      output += `$${index}`;
      continue;
    }
    output += current;
  }
  return output;
}

function postgresqlInsertOrIgnore(sql) {
  const source = String(sql || "");
  if (!/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(source)) return source;
  const insert = source.replace(
    /\bINSERT\s+OR\s+IGNORE\s+INTO\b/i,
    "INSERT INTO"
  );
  const returning = insert.search(/\bRETURNING\b/i);
  if (returning < 0)
    return `${insert.replace(/;\s*$/, "")} ON CONFLICT DO NOTHING`;
  return `${insert.slice(0, returning)}ON CONFLICT DO NOTHING ${insert.slice(returning)}`;
}

function postgresqlTimeFunctions(sql) {
  return String(sql || "")
    .replace(/datetime\(\s*'now'\s*\)/gi, "CURRENT_TIMESTAMP")
    .replace(
      /strftime\(\s*'%s'\s*,\s*'now'\s*\)/gi,
      "EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)"
    );
}

function adaptRawSql(sql, env = process.env) {
  if (!isPostgresql(env)) return String(sql || "");
  return postgresqlPlaceholders(
    postgresqlTimeFunctions(postgresqlInsertOrIgnore(sql))
  );
}

function installRawSqlDialectAdapter(client, env = process.env) {
  if (!isPostgresql(env) || client.$rawSqlDialectInstalled) return client;
  for (const method of ["$queryRawUnsafe", "$executeRawUnsafe"]) {
    const original = client[method].bind(client);
    client[method] = (sql, ...params) =>
      original(adaptRawSql(sql, env), ...params);
  }
  client.$rawSqlDialectInstalled = true;
  return client;
}

function installMigrationWriteBarrier(client, env = process.env) {
  const mode = String(
    env.ATHENA_DATABASE_MIGRATION_MODE || "off"
  ).toLowerCase();
  if (mode !== "cutover" || !client?.$use) return client;
  const writeActions = new Set([
    "create",
    "createMany",
    "delete",
    "deleteMany",
    "executeRaw",
    "executeRawUnsafe",
    "update",
    "updateMany",
    "upsert",
  ]);
  client.$use(async (params, next) => {
    if (!writeActions.has(params.action)) return next(params);
    const error = new Error("database_migration_write_barrier_active");
    error.code = "DATABASE_MIGRATION_WRITE_BARRIER_ACTIVE";
    throw error;
  });
  return client;
}

module.exports = {
  adaptRawSql,
  installMigrationWriteBarrier,
  installRawSqlDialectAdapter,
  postgresqlInsertOrIgnore,
  postgresqlPlaceholders,
  postgresqlTimeFunctions,
};
