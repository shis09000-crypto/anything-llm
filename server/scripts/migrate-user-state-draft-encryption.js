#!/usr/bin/env node
const { safeJsonParse } = require("../utils/http");
const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");

let prisma;
let contentHash;
let decodeUserStateValue;
let encodeUserStateValue;
let isProtectedUserStateValue;

function summary(rows = []) {
  return rows.reduce(
    (result, row) => {
      const parsed = safeJsonParse(row.value, null);
      if (isProtectedUserStateValue(parsed)) result.protected += 1;
      else if (parsed === null) result.invalid += 1;
      else result.pending += 1;
      result.total += 1;
      return result;
    },
    { total: 0, protected: 0, pending: 0, invalid: 0 }
  );
}

async function migrateDrafts({ apply = false } = {}) {
  const rows = await prisma.user_state_preferences.findMany({
    where: { namespace: "chat.draft" },
    select: {
      id: true,
      userId: true,
      namespace: true,
      scope: true,
      value: true,
    },
    orderBy: { id: "asc" },
  });
  const before = summary(rows);
  if (!apply || before.pending === 0) {
    return { mode: apply ? "apply" : "dry-run", before, migrated: 0 };
  }
  if (before.invalid > 0) {
    const error = new Error("chat_draft_migration_invalid_json");
    error.code = "chat_draft_migration_invalid_json";
    throw error;
  }

  let migrated = 0;
  await prisma.$transaction(async (tx) => {
    for (const row of rows) {
      const value = safeJsonParse(row.value, null);
      if (isProtectedUserStateValue(value)) continue;
      const storedValue = encodeUserStateValue({
        userId: row.userId,
        namespace: row.namespace,
        scope: row.scope,
        value,
      });
      const verified = decodeUserStateValue({
        userId: row.userId,
        namespace: row.namespace,
        scope: row.scope,
        storedValue,
      });
      if (contentHash(verified) !== contentHash(value)) {
        const error = new Error("chat_draft_migration_verification_failed");
        error.code = "chat_draft_migration_verification_failed";
        throw error;
      }
      const result = await tx.user_state_preferences.updateMany({
        where: { id: row.id, value: row.value },
        data: { value: storedValue },
      });
      if (Number(result.count || 0) !== 1) {
        const error = new Error("chat_draft_migration_concurrent_update");
        error.code = "chat_draft_migration_concurrent_update";
        throw error;
      }
      migrated += 1;
    }
  });
  return { mode: "apply", before, migrated };
}

async function main() {
  const requestedApply = process.argv.includes("--apply");
  const execute = process.argv.includes("--execute");
  const apply = requestedApply && execute;
  await bootstrapCliRuntime({
    access: apply ? "write" : "read",
    execute: apply,
    requiredTables: ["user_state_preferences"],
  });
  prisma = require("../utils/prisma");
  contentHash = require("../utils/syncV2/canonicalJson").contentHash;
  ({
    decodeUserStateValue,
    encodeUserStateValue,
    isProtectedUserStateValue,
  } = require("../utils/security/userStateValueProtection"));
  const result = await migrateDrafts({
    apply,
  });
  console.log(
    JSON.stringify({
      ...result,
      requestedApply,
      instruction:
        requestedApply && !execute
          ? "Repeat with explicit APP_ENV or --env plus --execute to mutate."
          : null,
    })
  );
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(
        JSON.stringify({
          success: false,
          error: error?.code || error?.message || "draft_migration_failed",
        })
      );
      process.exitCode = 1;
    })
    .finally(() => prisma?.$disconnect());
}

module.exports = { migrateDrafts, summary };
