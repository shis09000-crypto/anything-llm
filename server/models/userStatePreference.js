const prisma = require("../utils/prisma");
const { safeJsonParse } = require("../utils/http");

const TABLE_NAME = "user_state_preferences";
const DEFAULT_SCOPE = "global";
const DEFAULT_VERSION = "1";

function placeholders(values = []) {
  return values.map(() => "?").join(",");
}

function rowToState(row = {}) {
  if (!row) return null;
  return {
    namespace: row.namespace,
    scope: row.scope || DEFAULT_SCOPE,
    value: safeJsonParse(row.value, null),
    version: row.version || DEFAULT_VERSION,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  };
}

const UserStatePreference = {
  DEFAULT_SCOPE,
  DEFAULT_VERSION,

  ensureTable: async function () {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "${TABLE_NAME}" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "userId" INTEGER NOT NULL,
        "namespace" TEXT NOT NULL,
        "scope" TEXT NOT NULL DEFAULT 'global',
        "value" TEXT NOT NULL,
        "version" TEXT NOT NULL DEFAULT '1',
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "user_state_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "user_state_preferences_userId_namespace_scope_key" ON "${TABLE_NAME}"("userId", "namespace", "scope")`
    );
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "user_state_preferences_userId_namespace_idx" ON "${TABLE_NAME}"("userId", "namespace")`
    );
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "user_state_preferences_updatedAt_idx" ON "${TABLE_NAME}"("updatedAt")`
    );
  },

  where: async function ({ userId, namespaces = null, scopes = null } = {}) {
    if (!userId) return [];
    await this.ensureTable();

    const params = [Number(userId)];
    const clauses = [`"userId" = ?`];
    if (Array.isArray(namespaces) && namespaces.length > 0) {
      clauses.push(`"namespace" IN (${placeholders(namespaces)})`);
      params.push(...namespaces.map(String));
    }
    if (Array.isArray(scopes) && scopes.length > 0) {
      clauses.push(`"scope" IN (${placeholders(scopes)})`);
      params.push(...scopes.map(String));
    }

    const rows = await prisma.$queryRawUnsafe(
      `SELECT "namespace", "scope", "value", "version", "updatedAt", "createdAt"
        FROM "${TABLE_NAME}"
        WHERE ${clauses.join(" AND ")}
        ORDER BY "updatedAt" DESC`,
      ...params
    );
    return rows.map(rowToState).filter(Boolean);
  },

  upsertMany: async function ({ userId, states = [] } = {}) {
    if (!userId || !Array.isArray(states) || states.length === 0) return [];
    await this.ensureTable();

    const now = new Date();
    const saved = [];
    for (const state of states) {
      const namespace = String(state.namespace);
      const scope = String(state.scope || DEFAULT_SCOPE);
      const version = String(state.version || DEFAULT_VERSION);
      const value = JSON.stringify(state.value ?? null);
      await prisma.$executeRawUnsafe(
        `INSERT INTO "${TABLE_NAME}"
          ("userId", "namespace", "scope", "value", "version", "createdAt", "updatedAt")
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT("userId", "namespace", "scope") DO UPDATE SET
            "value" = excluded."value",
            "version" = excluded."version",
            "updatedAt" = excluded."updatedAt"`,
        Number(userId),
        namespace,
        scope,
        value,
        version,
        now,
        now
      );
      saved.push({
        namespace,
        scope,
        value: state.value ?? null,
        version,
        updatedAt: now,
      });
    }
    return saved;
  },

  delete: async function ({ userId, namespace, scope = null } = {}) {
    if (!userId || !namespace) return { count: 0 };
    await this.ensureTable();

    const params = [Number(userId), String(namespace)];
    let scopeClause = "";
    if (scope) {
      scopeClause = ` AND "scope" = ?`;
      params.push(String(scope));
    }

    const result = await prisma.$executeRawUnsafe(
      `DELETE FROM "${TABLE_NAME}" WHERE "userId" = ? AND "namespace" = ?${scopeClause}`,
      ...params
    );
    return { count: Number(result || 0) };
  },
};

module.exports = { UserStatePreference };
