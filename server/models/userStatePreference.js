const prisma = require("../utils/prisma");
const {
  ensureMigrationOwnedTables,
} = require("../utils/database/schemaIntrospection");
const { SyncV2 } = require("./syncV2");
const { nodeKeys } = require("../utils/syncV2/nodeRegistry");
const {
  decodeUserStateValue,
  encodeUserStateValue,
} = require("../utils/security/userStateValueProtection");
const { userStateMergePolicy } = require("../utils/userStatePreferencePolicy");

const TABLE_NAME = "user_state_preferences";
const DEFAULT_SCOPE = "global";
const DEFAULT_VERSION = "1";
let tableReady = false;

function placeholders(values = []) {
  return values.map(() => "?").join(",");
}

function rowToState(row = {}) {
  if (!row) return null;
  const decodedValue = decodeUserStateValue({
    userId: row.userId,
    namespace: row.namespace,
    scope: row.scope || DEFAULT_SCOPE,
    storedValue: row.value,
  });
  const value =
    row.monotonicCursor !== null &&
    row.monotonicCursor !== undefined &&
    decodedValue &&
    typeof decodedValue === "object" &&
    !Array.isArray(decodedValue)
      ? {
          ...decodedValue,
          cursor: Math.max(
            Number(decodedValue.cursor || 0),
            Number(row.monotonicCursor || 0)
          ),
        }
      : decodedValue;
  return {
    namespace: row.namespace,
    scope: row.scope || DEFAULT_SCOPE,
    value,
    version: row.version || DEFAULT_VERSION,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  };
}

function stripClientDirty(value) {
  if (Array.isArray(value)) return value.map(stripClientDirty);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "dirty")
      .map(([key, entry]) => [key, stripClientDirty(entry)])
  );
}

function mergePatch(target, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const result =
    target && typeof target === "object" && !Array.isArray(target)
      ? { ...target }
      : {};
  for (const [key, value] of Object.entries(patch)) {
    if (["dirty", "updatedAt"].includes(key)) continue;
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

function monotonicCursorMerge(currentValue, payload) {
  const current =
    currentValue &&
    typeof currentValue === "object" &&
    !Array.isArray(currentValue)
      ? currentValue
      : {};
  const incoming =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : {};
  const currentCursor = Math.max(0, Number(current.cursor) || 0);
  const incomingCursor = Math.max(0, Number(incoming.cursor) || 0);
  if (incomingCursor <= currentCursor) return current;
  return { ...current, ...incoming, cursor: incomingCursor };
}

async function currentStateResult(
  tx,
  { userId, namespace, scope, nodeKey, syncReady, row = null }
) {
  const currentRow =
    row ||
    (
      await tx.$queryRawUnsafe(
        `SELECT "userId", "namespace", "scope", "value", "version", "monotonicCursor", "updatedAt", "createdAt" FROM "${TABLE_NAME}"
         WHERE "userId" = ? AND "namespace" = ? AND "scope" = ?
         LIMIT 1`,
        Number(userId),
        namespace,
        scope
      )
    )[0] ||
    null;
  if (!currentRow) return null;
  const existingNode = syncReady
    ? await tx.sync_nodes.findUnique({ where: { nodeKey } })
    : null;
  return {
    ...rowToState(currentRow),
    ...(existingNode
      ? {
          stateVersion: existingNode.stateVersion,
          hash: existingNode.contentHash,
        }
      : {}),
  };
}

function applyMutationOperation(
  currentValue,
  operation,
  payload,
  mergePolicy = "version-merge"
) {
  const cleanPayload = stripClientDirty(payload);
  if (mergePolicy === "monotonic-cursor") {
    return monotonicCursorMerge(currentValue, cleanPayload);
  }
  if (operation === "merge") return mergePatch(currentValue, cleanPayload);
  if (operation === "replace") return cleanPayload;
  if (["set-add", "set-remove"].includes(operation)) {
    const set = new Set(Array.isArray(currentValue) ? currentValue : []);
    const values = Array.isArray(cleanPayload) ? cleanPayload : [cleanPayload];
    for (const item of values) {
      if (operation === "set-add") set.add(item);
      else set.delete(item);
    }
    return [...set];
  }
  return stripClientDirty(currentValue);
}

const UserStatePreference = {
  DEFAULT_SCOPE,
  DEFAULT_VERSION,

  ensureTable: async function () {
    if (tableReady) return;
    if (
      await ensureMigrationOwnedTables(prisma, [TABLE_NAME], {
        context: "user-state-preferences",
      })
    ) {
      tableReady = true;
      return;
    }
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "${TABLE_NAME}" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "userId" INTEGER NOT NULL,
        "namespace" TEXT NOT NULL,
        "scope" TEXT NOT NULL DEFAULT 'global',
        "value" TEXT NOT NULL,
        "version" TEXT NOT NULL DEFAULT '1',
        "monotonicCursor" INTEGER,
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
    tableReady = true;
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
      `SELECT "userId", "namespace", "scope", "value", "version", "monotonicCursor", "updatedAt", "createdAt"
        FROM "${TABLE_NAME}"
        WHERE ${clauses.join(" AND ")}
        ORDER BY "updatedAt" DESC`,
      ...params
    );
    return rows.map(rowToState).filter(Boolean);
  },

  upsertMany: async function ({ userId, states = [], syncContext = {} } = {}) {
    if (!userId || !Array.isArray(states) || states.length === 0) return [];
    await this.ensureTable();

    const syncReady =
      SyncV2.enabled("preferences") && (await SyncV2.schemaReady());
    return await prisma.$transaction(async (tx) => {
      const now = new Date();
      const saved = [];
      for (const state of states) {
        const namespace = String(state.namespace);
        const scope = String(state.scope || DEFAULT_SCOPE);
        const nodeKey = nodeKeys.userPreferences(userId, namespace, scope);
        const mergePolicy = userStateMergePolicy(namespace);
        // A max cursor is a commutative, monotonic register. It is safe to
        // merge across an old baseVersion and must not create a user-visible
        // conflict merely because another device already advanced the cursor.
        if (syncReady && mergePolicy !== "monotonic-cursor") {
          await SyncV2.assertMutationVersion(tx, {
            nodeKey,
            baseVersion: state.baseVersion ?? syncContext.baseVersion,
            changedPaths: state.changedPaths ||
              syncContext.changedPaths || ["value"],
          });
        }
        let currentRow = null;
        if (state.mutationOperation || mergePolicy === "monotonic-cursor") {
          currentRow =
            (
              await tx.$queryRawUnsafe(
                `SELECT "userId", "namespace", "scope", "value", "version", "monotonicCursor", "updatedAt", "createdAt" FROM "${TABLE_NAME}"
               WHERE "userId" = ? AND "namespace" = ? AND "scope" = ?
               LIMIT 1`,
                Number(userId),
                namespace,
                scope
              )
            )[0] || null;
        }
        const version = String(
          state.version || currentRow?.version || DEFAULT_VERSION
        );
        const currentValue = currentRow
          ? decodeUserStateValue({
              userId,
              namespace,
              scope,
              storedValue: currentRow.value,
            })
          : null;
        const cleanValue = state.mutationOperation
          ? applyMutationOperation(
              currentValue,
              state.mutationOperation,
              state.mutationPayload,
              mergePolicy
            )
          : stripClientDirty(state.value ?? null);
        if (
          mergePolicy === "monotonic-cursor" &&
          currentRow &&
          Number(cleanValue?.cursor || 0) <=
            Math.max(
              Number(currentRow.monotonicCursor || 0),
              Number(currentValue?.cursor || 0)
            )
        ) {
          saved.push(
            await currentStateResult(tx, {
              userId,
              namespace,
              scope,
              nodeKey,
              syncReady,
              row: currentRow,
            })
          );
          continue;
        }
        const value = encodeUserStateValue({
          userId,
          namespace,
          scope,
          value: cleanValue,
        });
        const monotonicUpdateGuard =
          mergePolicy === "monotonic-cursor"
            ? ` WHERE COALESCE("${TABLE_NAME}"."monotonicCursor", 0) < excluded."monotonicCursor"`
            : "";
        const monotonicCursor =
          mergePolicy === "monotonic-cursor"
            ? Number(cleanValue?.cursor || 0)
            : null;
        const writeCount = await tx.$executeRawUnsafe(
          `INSERT INTO "${TABLE_NAME}"
            ("userId", "namespace", "scope", "value", "version", "monotonicCursor", "createdAt", "updatedAt")
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT("userId", "namespace", "scope") DO UPDATE SET
              "value" = excluded."value",
              "version" = excluded."version",
              "monotonicCursor" = excluded."monotonicCursor",
              "updatedAt" = excluded."updatedAt"${monotonicUpdateGuard}`,
          Number(userId),
          namespace,
          scope,
          value,
          version,
          monotonicCursor,
          now,
          now
        );
        // A concurrent device may have committed a higher cursor after our
        // read. The guarded UPSERT then changes zero rows; return the winner
        // without emitting a stale node version or Outbox event.
        if (mergePolicy === "monotonic-cursor" && Number(writeCount) === 0) {
          saved.push(
            await currentStateResult(tx, {
              userId,
              namespace,
              scope,
              nodeKey,
              syncReady,
            })
          );
          continue;
        }
        let sync = null;
        if (syncReady) {
          sync = await SyncV2.recordNodeChange(tx, {
            nodeKey,
            content: {
              namespace,
              scope,
              schemaVersion: version,
              value: cleanValue,
            },
            eventType: "preference.updated",
            changedPaths: state.changedPaths ||
              syncContext.changedPaths || ["value"],
            payloadHint: { namespace, scope },
            originClientId: syncContext.originClientId,
            mutationId: state.mutationId || syncContext.mutationId,
          });
        }
        saved.push({
          namespace,
          scope,
          value: cleanValue,
          version,
          updatedAt: now,
          ...(sync
            ? {
                stateVersion: sync.node.stateVersion,
                hash: sync.node.hash,
              }
            : {}),
        });
      }
      return saved;
    });
  },

  delete: async function ({
    userId,
    namespace,
    scope = null,
    syncContext = {},
  } = {}) {
    if (!userId || !namespace) return { count: 0 };
    await this.ensureTable();

    const params = [Number(userId), String(namespace)];
    let scopeClause = "";
    if (scope) {
      scopeClause = ` AND "scope" = ?`;
      params.push(String(scope));
    }

    const syncReady =
      SyncV2.enabled("preferences") && (await SyncV2.schemaReady());
    return await prisma.$transaction(async (tx) => {
      const nodeKey = nodeKeys.userPreferences(
        userId,
        namespace,
        scope || DEFAULT_SCOPE
      );
      if (syncReady) {
        await SyncV2.assertMutationVersion(tx, {
          nodeKey,
          baseVersion: syncContext.baseVersion,
          changedPaths: syncContext.changedPaths || ["$"],
        });
      }
      const result = await tx.$executeRawUnsafe(
        `DELETE FROM "${TABLE_NAME}" WHERE "userId" = ? AND "namespace" = ?${scopeClause}`,
        ...params
      );
      let sync = null;
      if (syncReady) {
        sync = await SyncV2.recordNodeChange(tx, {
          nodeKey,
          content: { deleted: true },
          deletedAt: new Date(),
          eventType: "preference.deleted",
          changedPaths: syncContext.changedPaths || ["$"],
          payloadHint: { namespace, scope: scope || DEFAULT_SCOPE },
          originClientId: syncContext.originClientId,
          mutationId: syncContext.mutationId,
        });
      }
      return {
        count: Number(result || 0),
        ...(sync ? { stateVersion: sync.node.stateVersion } : {}),
      };
    });
  },
};

module.exports = {
  UserStatePreference,
  _internals: { applyMutationOperation, monotonicCursorMerge },
};
