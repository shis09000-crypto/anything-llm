#!/usr/bin/env node
const {
  assertDatabaseSchema,
  bootstrapCliRuntime,
} = require("./lib/runtimeBootstrap");

let PrismaClient;

function accountRoleHelpers() {
  return require("../utils/authz/accountRoles");
}

const VALID_ENVS = new Set(["development", "production"]);

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    env:
      process.env.APP_ENV === "production" ||
      process.env.NODE_ENV === "production"
        ? "production"
        : "development",
    dryRun: true,
    execute: argv.includes("--execute"),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--fix") {
      args.dryRun = !args.execute;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--env") {
      args.env = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--env=")) {
      args.env = arg.slice("--env=".length);
    }
  }

  args.env = String(args.env || "")
    .trim()
    .toLowerCase();
  if (!VALID_ENVS.has(args.env)) {
    throw new Error(
      `Invalid --env "${args.env}". Expected development or production.`
    );
  }
  return args;
}

function sqliteUrl(dbPath) {
  const url = new URL(`file:${dbPath}`);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "10");
  return url.toString();
}

function client(url) {
  return new PrismaClient({
    datasources: { db: { url } },
    log: ["error", "warn"],
  });
}

function normalizeEmail(email = "") {
  const value = String(email || "")
    .trim()
    .toLowerCase();
  return value || null;
}

function normalizePhone(phone = "") {
  const value = String(phone || "").trim();
  return value || null;
}

function identityClauses(user = {}) {
  const clauses = [];
  if (user.username) clauses.push({ username: user.username });
  const email = normalizeEmail(user.email);
  if (email) clauses.push({ email });
  const phone = normalizePhone(user.phone);
  if (phone) clauses.push({ phone });
  return clauses;
}

function authUserCreateData(user = {}, envName = "development") {
  const { deriveRoleDefaults, normalizeRole } = accountRoleHelpers();
  const roleDefaults = deriveRoleDefaults({
    role: normalizeRole(user.role || "user"),
    status: user.status,
    originEnv: user.originEnv || envName,
    allowedEnvs: user.allowedEnvs,
    suspended: user.suspended,
    ownerType: user.ownerType,
    username: user.username,
    email: normalizeEmail(user.email),
  });

  return {
    username: user.username,
    displayName: user.displayName || user.username,
    password: user.password,
    pfpFilename: user.pfpFilename,
    role: roleDefaults.role,
    status: roleDefaults.status,
    allowedEnvs: roleDefaults.allowedEnvs,
    ownerType: roleDefaults.ownerType,
    suspended: roleDefaults.suspended,
    previousRole: user.previousRole,
    previousAllowedEnvs: user.previousAllowedEnvs,
    previousOwnerType: user.previousOwnerType,
    banActorRole: user.banActorRole,
    banActorOwnerType: user.banActorOwnerType,
    banActorAuthUserId: user.banActorAuthUserId,
    bannedAt: user.bannedAt,
    dailyMessageLimit: user.dailyMessageLimit,
    bio: user.bio || "",
    seen_recovery_codes: Boolean(user.seen_recovery_codes),
    email: normalizeEmail(user.email),
    email_verified_at: user.email_verified_at,
    phone: normalizePhone(user.phone),
    phone_verified_at: user.phone_verified_at,
    originEnv: roleDefaults.originEnv,
  };
}

function summarizeUser(user = {}) {
  return {
    id: user.id,
    authUserId: user.authUserId || null,
    username: user.username || null,
    email: normalizeEmail(user.email),
    phone: normalizePhone(user.phone),
  };
}

async function findMatchingAuthUser(authDb, user) {
  const clauses = identityClauses(user);
  if (clauses.length === 0) return null;
  return authDb.users.findFirst({ where: { OR: clauses } });
}

async function ensureAuthIdentity({
  authDb,
  envDb,
  user,
  envName,
  dryRun = true,
}) {
  const existing = user.authUserId
    ? await authDb.users.findUnique({ where: { id: Number(user.authUserId) } })
    : null;

  if (existing) {
    return { action: "valid", authUserId: existing.id };
  }

  const matched = await findMatchingAuthUser(authDb, user);
  if (matched) {
    if (!dryRun) {
      await envDb.users.update({
        where: { id: user.id },
        data: { authUserId: matched.id, originEnv: envName },
      });
    }
    return {
      action: user.authUserId ? "relinked_missing_auth" : "linked_existing",
      authUserId: matched.id,
      dryRun,
    };
  }

  if (dryRun) {
    return {
      action: user.authUserId ? "would_recreate_missing_auth" : "would_create",
      authUserId: null,
      dryRun: true,
    };
  }

  const created = await authDb.users.create({
    data: authUserCreateData(user, envName),
  });
  await envDb.users.update({
    where: { id: user.id },
    data: { authUserId: created.id, originEnv: envName },
  });
  return {
    action: user.authUserId ? "recreated_missing_auth" : "created",
    authUserId: created.id,
    dryRun: false,
  };
}

function duplicateAuthUserIds(users = []) {
  const counts = new Map();
  for (const user of users) {
    if (!user.authUserId) continue;
    const id = Number(user.authUserId);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([authUserId, count]) => ({ authUserId, count }));
}

async function auditSharedAuthIdentity({
  envDb,
  authDb,
  envName,
  dryRun = true,
  logger = console,
}) {
  const users = await envDb.users.findMany({ orderBy: { id: "asc" } });
  const duplicates = duplicateAuthUserIds(users);
  const results = [];

  for (const user of users) {
    const result = await ensureAuthIdentity({
      authDb,
      envDb,
      user,
      envName,
      dryRun,
    });
    results.push({ user: summarizeUser(user), ...result });
  }

  const summary = {
    envName,
    dryRun,
    totalUsers: users.length,
    valid: results.filter((result) => result.action === "valid").length,
    linkedExisting: results.filter(
      (result) => result.action === "linked_existing"
    ).length,
    created: results.filter((result) => result.action === "created").length,
    missingAuthRepaired: results.filter((result) =>
      ["relinked_missing_auth", "recreated_missing_auth"].includes(
        result.action
      )
    ).length,
    pendingFixes: results.filter((result) => result.action.startsWith("would_"))
      .length,
    duplicates,
    results,
  };

  logger.log(
    `[audit-shared-auth-identity] ${dryRun ? "dry-run" : "fix"} ${envName}: ` +
      `${summary.valid}/${summary.totalUsers} valid, ` +
      `${summary.linkedExisting} linked, ${summary.created} created, ` +
      `${summary.missingAuthRepaired} repaired, ${summary.pendingFixes} pending.`
  );
  if (duplicates.length > 0) {
    logger.warn(
      `[audit-shared-auth-identity] duplicate authUserId values found: ${JSON.stringify(
        duplicates
      )}`
    );
  }

  return summary;
}

async function main() {
  const args = parseArgs();
  const runtime = await bootstrapCliRuntime({
    access: args.dryRun ? "read" : "write",
    execute: args.execute,
    argv: [...process.argv.slice(2), `--env=${args.env}`],
    requiredTables: ["users", "_prisma_migrations"],
  });
  await assertDatabaseSchema({
    databasePath: runtime.authDatabasePath,
    requiredTables: ["users", "auth_sessions", "_prisma_migrations"],
    label: "auth",
  });
  PrismaClient = require("@prisma/client").PrismaClient;

  const envDb = client(sqliteUrl(runtime.databasePath));
  const authDb = client(sqliteUrl(runtime.authDatabasePath));
  try {
    await auditSharedAuthIdentity({
      envDb,
      authDb,
      envName: args.env,
      dryRun: args.dryRun,
    });
  } finally {
    await Promise.allSettled([envDb.$disconnect(), authDb.$disconnect()]);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[audit-shared-auth-identity] ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  auditSharedAuthIdentity,
  authUserCreateData,
  duplicateAuthUserIds,
  ensureAuthIdentity,
  parseArgs,
};
