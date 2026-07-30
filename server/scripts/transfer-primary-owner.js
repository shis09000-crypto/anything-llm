#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");

const OWNER_FIELDS = {
  role: true,
  ownerType: true,
  status: true,
  suspended: true,
  allowedEnvs: true,
  originEnv: true,
};

function hasArg(name) {
  return process.argv.includes(name);
}

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function identityFingerprint(value) {
  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex")
    .slice(0, 12);
}

function sqliteUrl(databasePath, readOnly = false) {
  const url = new URL(`file:${databasePath}`);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "10");
  if (readOnly) url.searchParams.set("mode", "ro");
  return url.toString();
}

function ownerRoleData() {
  return {
    role: "owner",
    ownerType: "primary",
    status: "active",
    suspended: 0,
    allowedEnvs: JSON.stringify(["production", "development"]),
    originEnv: "production",
  };
}

function adminRoleData() {
  return {
    role: "admin",
    ownerType: null,
    status: "active",
    suspended: 0,
    allowedEnvs: JSON.stringify(["production", "development"]),
    originEnv: "production",
  };
}

async function activePrimaryOwners(client) {
  return client.users.findMany({
    where: {
      role: "owner",
      ownerType: "primary",
      status: "active",
      suspended: 0,
    },
    select: {
      id: true,
      authUserId: true,
      email: true,
      ...OWNER_FIELDS,
    },
    take: 2,
  });
}

async function main() {
  const targetEmail = String(arg("--target-email", "")).trim().toLowerCase();
  if (!targetEmail) throw new Error("target_email_required");
  const apply = hasArg("--apply") && hasArg("--execute");
  const allowRootPending = hasArg("--allow-root-pending");
  const runtime = await bootstrapCliRuntime({
    access: apply ? "write" : "read",
    execute: apply,
    requiredTables: ["users", "_prisma_migrations"],
  });
  if (runtime.databaseProvider !== "sqlite") {
    throw new Error("primary_owner_transfer_sqlite_only");
  }
  const { PrismaClient } = require("@prisma/client");

  const authPrisma = require("../utils/authPrisma");
  await authPrisma.$authPrismaReady;
  const currentPrimary = await activePrimaryOwners(authPrisma);
  if (currentPrimary.length !== 1) {
    const error = new Error("unique_active_primary_owner_required");
    error.details = { count: currentPrimary.length };
    throw error;
  }
  const previousPrimary = currentPrimary[0];
  const target = await authPrisma.users.findFirst({
    where: { email: targetEmail, status: "active", suspended: 0 },
    select: {
      id: true,
      authUserId: true,
      email: true,
      ...OWNER_FIELDS,
    },
  });
  if (!target) throw new Error("target_active_account_not_found");
  if (Number(target.id) === Number(previousPrimary.id)) {
    throw new Error("target_is_already_primary_owner");
  }
  if (target.role !== "admin") {
    const error = new Error("target_must_be_active_admin");
    error.details = { role: target.role };
    throw error;
  }
  const targetRoot = await authPrisma.user_root_key_epochs.findFirst({
    where: { authUserId: target.id, status: "active" },
    select: { rootKeyId: true, rootEpoch: true },
    orderBy: { rootEpoch: "desc" },
  });
  if (!targetRoot && !allowRootPending) {
    throw new Error("target_active_root_required");
  }

  const storageBase = path.dirname(path.dirname(runtime.databasePath));
  const mainDatabasePaths = ["development", "production"]
    .map((environment) => ({
      environment,
      databasePath: path.join(storageBase, environment, "anythingllm.db"),
    }))
    .filter(({ databasePath }) => fs.existsSync(databasePath));
  if (!mainDatabasePaths.length) throw new Error("main_database_missing");

  const mainClients = mainDatabasePaths.map((entry) => ({
    ...entry,
    client: new PrismaClient({
      log: ["error"],
      datasources: {
        db: { url: sqliteUrl(entry.databasePath, !apply) },
      },
    }),
  }));

  try {
    const shadowState = [];
    for (const entry of mainClients) {
      const [previousRows, targetRows] = await Promise.all([
        entry.client.users.findMany({
          where: { authUserId: previousPrimary.id },
          select: { id: true, authUserId: true, ...OWNER_FIELDS },
        }),
        entry.client.users.findMany({
          where: { authUserId: target.id },
          select: { id: true, authUserId: true, ...OWNER_FIELDS },
        }),
      ]);
      shadowState.push({
        ...entry,
        previousRows,
        targetRows,
      });
    }
    if (
      !shadowState.some((entry) => entry.targetRows.length > 0) ||
      !shadowState.some((entry) => entry.previousRows.length > 0)
    ) {
      throw new Error("account_shadow_mapping_required");
    }

    const summary = {
      success: true,
      mode: apply ? "applied" : "dry-run",
      environment: runtime.appEnv,
      previousPrimary: {
        identityFingerprint: identityFingerprint(previousPrimary.id),
        nextRole: "admin",
      },
      target: {
        identityFingerprint: identityFingerprint(target.id),
        currentRole: target.role,
        nextRole: "owner",
        nextOwnerType: "primary",
        activeRoot: Boolean(targetRoot),
        rootPendingAcknowledged: !targetRoot && allowRootPending,
      },
      shadows: shadowState.map((entry) => ({
        environment: entry.environment,
        previousPrimaryRows: entry.previousRows.length,
        targetRows: entry.targetRows.length,
      })),
    };
    if (!apply) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    const changedMain = [];
    let authChanged = false;
    try {
      await authPrisma.$transaction(async (tx) => {
        await tx.users.update({
          where: { id: previousPrimary.id },
          data: adminRoleData(),
        });
        await tx.users.update({
          where: { id: target.id },
          data: ownerRoleData(),
        });
      });
      authChanged = true;

      for (const entry of shadowState) {
        await entry.client.$transaction(async (tx) => {
          await tx.users.updateMany({
            where: { authUserId: previousPrimary.id },
            data: adminRoleData(),
          });
          await tx.users.updateMany({
            where: { authUserId: target.id },
            data: ownerRoleData(),
          });
        });
        changedMain.push(entry);
      }
    } catch (error) {
      for (const entry of changedMain.reverse()) {
        await entry.client.$transaction(async (tx) => {
          for (const row of entry.previousRows) {
            await tx.users.update({
              where: { id: row.id },
              data: Object.fromEntries(
                Object.keys(OWNER_FIELDS).map((field) => [field, row[field]])
              ),
            });
          }
          for (const row of entry.targetRows) {
            await tx.users.update({
              where: { id: row.id },
              data: Object.fromEntries(
                Object.keys(OWNER_FIELDS).map((field) => [field, row[field]])
              ),
            });
          }
        });
      }
      if (authChanged) {
        await authPrisma.$transaction(async (tx) => {
          await tx.users.update({
            where: { id: previousPrimary.id },
            data: Object.fromEntries(
              Object.keys(OWNER_FIELDS).map((field) => [
                field,
                previousPrimary[field],
              ])
            ),
          });
          await tx.users.update({
            where: { id: target.id },
            data: Object.fromEntries(
              Object.keys(OWNER_FIELDS).map((field) => [field, target[field]])
            ),
          });
        });
      }
      throw error;
    }

    const verifiedPrimary = await activePrimaryOwners(authPrisma);
    if (
      verifiedPrimary.length !== 1 ||
      Number(verifiedPrimary[0].id) !== Number(target.id)
    ) {
      throw new Error("primary_owner_transfer_verification_failed");
    }
    for (const entry of shadowState) {
      const [primaryCount, formerPrimary] = await Promise.all([
        entry.client.users.count({
          where: {
            authUserId: target.id,
            role: "owner",
            ownerType: "primary",
            status: "active",
          },
        }),
        entry.client.users.findFirst({
          where: { authUserId: previousPrimary.id },
          select: { role: true, ownerType: true },
        }),
      ]);
      if (
        entry.targetRows.length > 0 &&
        primaryCount !== entry.targetRows.length
      ) {
        throw new Error(
          `primary_owner_shadow_verification_failed:${entry.environment}`
        );
      }
      if (
        entry.previousRows.length > 0 &&
        (formerPrimary?.role !== "admin" || formerPrimary?.ownerType !== null)
      ) {
        throw new Error(
          `primary_owner_shadow_verification_failed:${entry.environment}`
        );
      }
    }

    console.log(
      JSON.stringify(
        {
          ...summary,
          verified: true,
          uniquePrimaryOwner: true,
          targetRootPreserved: Boolean(targetRoot),
          privateKeyBootstrapPending: !targetRoot,
        },
        null,
        2
      )
    );
  } finally {
    await Promise.allSettled([
      ...mainClients.map((entry) => entry.client.$disconnect()),
      authPrisma.$disconnect(),
    ]);
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        success: false,
        error: error.message,
        code: error.code || null,
        details: error.details || null,
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
