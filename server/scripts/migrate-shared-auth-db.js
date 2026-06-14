#!/usr/bin/env node
const path = require("path");
const fs = require("fs");
const { PrismaClient } = require("@prisma/client");

const serverRoot = path.resolve(__dirname, "..");
const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: path.join(serverRoot, envPath) });

const { storageBaseDir, authDatabaseUrl } = require("../utils/environment");
const {
  deriveRoleDefaults,
  normalizeRole,
} = require("../utils/authz/accountRoles");

const dryRun = process.argv.includes("--dry-run");

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

function identityKey(user = {}) {
  return {
    username: user.username ? String(user.username).toLowerCase() : null,
    email: user.email ? String(user.email).trim().toLowerCase() : null,
  };
}

function conflictReason(existing = {}, next = {}) {
  const a = identityKey(existing);
  const b = identityKey(next);
  const usernameConflict =
    a.username &&
    b.username &&
    a.username === b.username &&
    a.email !== b.email;
  const emailConflict =
    a.email && b.email && a.email === b.email && a.username !== b.username;
  if (usernameConflict) return "same username with different email";
  if (emailConflict) return "same email with different username";
  return null;
}

function legacyRoleFor(user = {}, originEnv) {
  if (user.suspended || user.status === "disabled" || user.role === "disabled")
    return "disabled";
  if (isPrimaryOwnerUser(user)) return "owner";
  const role = normalizeRole(
    user.role || (originEnv === "development" ? "developer" : "user")
  );
  if (["admin", "owner"].includes(role)) return "admin";
  if (originEnv === "development" && role === "user") return "developer";
  return role;
}

function isPrimaryOwnerUser(user = {}) {
  return (
    String(user.username || "")
      .trim()
      .toLowerCase() === "shis500225" ||
    String(user.email || "")
      .trim()
      .toLowerCase() === "shis500225@gmail.com"
  );
}

function authDataFromEnvUser(user = {}, originEnv) {
  const roleDefaults = deriveRoleDefaults({
    role: legacyRoleFor(user, originEnv),
    status: user.status,
    originEnv,
    allowedEnvs: user.allowedEnvs,
    suspended: user.suspended,
    ownerType: user.ownerType,
    username: user.username,
    email: user.email,
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
    seen_recovery_codes: Boolean(user.seen_recovery_codes),
    email: user.email ? String(user.email).trim().toLowerCase() : null,
    email_verified_at: user.email_verified_at || null,
    phone: user.phone || null,
    phone_verified_at: user.phone_verified_at || null,
    dailyMessageLimit: user.dailyMessageLimit,
    bio: user.bio || "",
    createdAt: user.createdAt || new Date(),
    lastUpdatedAt: user.lastUpdatedAt || new Date(),
    originEnv: roleDefaults.originEnv,
  };
}

async function readUsers(envName) {
  const dbPath = path.join(storageBaseDir(), envName, "anythingllm.db");
  if (!fs.existsSync(dbPath)) return { envName, dbPath, db: null, users: [] };
  const db = client(sqliteUrl(dbPath));
  const users = await db.users.findMany({ orderBy: { id: "asc" } });
  return { envName, dbPath, db, users };
}

async function upsertAuthUser(authDb, user, originEnv, maps, index) {
  const incoming = authDataFromEnvUser(user, originEnv);
  let existing = null;

  if (incoming.email) existing = index.email.get(incoming.email);
  if (!existing && incoming.username)
    existing = index.username.get(String(incoming.username).toLowerCase());

  if (existing) {
    const reason = conflictReason(existing, incoming);
    if (reason) {
      throw new Error(
        `Identity conflict for ${originEnv} user #${user.id}: ${reason}.`
      );
    }
    maps[originEnv].set(user.id, existing.id);
    return existing;
  }

  if (dryRun) {
    const pendingId = -1 * (maps[originEnv].size + 1);
    maps[originEnv].set(user.id, pendingId);
    return { id: pendingId, ...incoming };
  }

  const created = await authDb.users.create({ data: incoming });
  if (created.email) index.email.set(created.email, created);
  if (created.username)
    index.username.set(String(created.username).toLowerCase(), created);
  maps[originEnv].set(user.id, created.id);
  return created;
}

async function backfillEnvUsers(envInfo, map) {
  if (!envInfo.db) return 0;
  let count = 0;
  for (const [localId, authUserId] of map.entries()) {
    await envInfo.db.users.update({
      where: { id: localId },
      data: { authUserId, originEnv: envInfo.envName },
    });
    count += 1;
  }
  return count;
}

async function copyAuthTables(authDb, envInfo, map) {
  if (!envInfo.db) {
    return {
      recoveryCodes: 0,
      passwordResetTokens: 0,
      passkeys: 0,
      trustedDevices: 0,
      emailVerificationCodes: 0,
      invites: 0,
    };
  }

  const summary = {
    recoveryCodes: 0,
    passwordResetTokens: 0,
    passkeys: 0,
    trustedDevices: 0,
    emailVerificationCodes: 0,
    invites: 0,
  };

  for (const recoveryCode of await envInfo.db.recovery_codes.findMany()) {
    const userId = map.get(recoveryCode.user_id);
    if (!userId) continue;
    await authDb.recovery_codes.create({
      data: {
        user_id: userId,
        code_hash: recoveryCode.code_hash,
        createdAt: recoveryCode.createdAt,
      },
    });
    summary.recoveryCodes += 1;
  }

  for (const resetToken of await envInfo.db.password_reset_tokens.findMany()) {
    const userId = map.get(resetToken.user_id);
    if (!userId) continue;
    const exists = await authDb.password_reset_tokens.findUnique({
      where: { token: resetToken.token },
    });
    if (exists) continue;
    await authDb.password_reset_tokens.create({
      data: {
        user_id: userId,
        token: resetToken.token,
        expiresAt: resetToken.expiresAt,
        createdAt: resetToken.createdAt,
      },
    });
    summary.passwordResetTokens += 1;
  }

  for (const passkey of await envInfo.db.passkeyCredential.findMany()) {
    const userId = map.get(passkey.userId);
    if (!userId) continue;
    const exists = await authDb.passkeyCredential.findUnique({
      where: { credentialId: passkey.credentialId },
    });
    if (exists) continue;
    await authDb.passkeyCredential.create({
      data: {
        userId,
        credentialId: passkey.credentialId,
        publicKey: passkey.publicKey,
        counter: passkey.counter,
        transports: passkey.transports,
        deviceType: passkey.deviceType,
        deviceName: passkey.deviceName,
        browserName: passkey.browserName,
        platformName: passkey.platformName,
        aaguid: passkey.aaguid,
        provider: passkey.provider,
        providerName: passkey.providerName,
        backedUp: passkey.backedUp,
        createdAt: passkey.createdAt,
        lastUsedAt: passkey.lastUsedAt,
      },
    });
    summary.passkeys += 1;
  }

  for (const device of await envInfo.db.trustedLoginDevice.findMany()) {
    const userId = map.get(device.userId);
    if (!userId) continue;
    await authDb.trustedLoginDevice.upsert({
      where: { userId_deviceId: { userId, deviceId: device.deviceId } },
      create: {
        userId,
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        verifier: device.verifier,
        publicCommitment: device.publicCommitment,
        opaqueRegistrationRecord: device.opaqueRegistrationRecord,
        deviceSalt: device.deviceSalt,
        lastChallengeAt: device.lastChallengeAt,
        failureCount: device.failureCount,
        lockedUntil: device.lockedUntil,
        createdAt: device.createdAt,
        lastUsedAt: device.lastUsedAt,
        revokedAt: device.revokedAt,
      },
      update: {},
    });
    summary.trustedDevices += 1;
  }

  for (const verification of await envInfo.db.email_verification_codes.findMany()) {
    const userId = verification.user_id ? map.get(verification.user_id) : null;
    if (verification.user_id && !userId) continue;
    await authDb.email_verification_codes.create({
      data: {
        user_id: userId || null,
        email: verification.email,
        purpose: verification.purpose,
        code_hash: verification.code_hash,
        expiresAt: verification.expiresAt,
        attempts: verification.attempts,
        consumedAt: verification.consumedAt,
        request_ip: verification.request_ip,
        createdAt: verification.createdAt,
      },
    });
    summary.emailVerificationCodes += 1;
  }

  for (const invite of await envInfo.db.invites.findMany()) {
    const exists = invite.tokenHash
      ? await authDb.invites.findUnique({
          where: { tokenHash: invite.tokenHash },
        })
      : await authDb.invites.findFirst({ where: { code: invite.code } });
    if (exists) continue;
    await authDb.invites.create({
      data: {
        code: invite.code,
        tokenHash: invite.tokenHash,
        role: normalizeRole(invite.role || "user"),
        status: invite.status,
        claimedBy: invite.claimedBy,
        workspaceIds: invite.workspaceIds,
        createdAt: invite.createdAt,
        createdBy: invite.createdBy,
        createdByAdminId: invite.createdByAdminId,
        expiresAt: invite.expiresAt,
        consumedAt: invite.consumedAt,
        revokedAt: invite.revokedAt,
        usedByUserId: invite.usedByUserId,
        lastUpdatedAt: invite.lastUpdatedAt,
      },
    });
    summary.invites += 1;
  }

  return summary;
}

async function clearCopiedAuthTables(authDb, maps) {
  const userIds = [
    ...new Set(
      [...maps.production.values(), ...maps.development.values()].filter(
        Boolean
      )
    ),
  ];
  if (userIds.length === 0) return;

  await authDb.recovery_codes.deleteMany({
    where: { user_id: { in: userIds } },
  });
  await authDb.password_reset_tokens.deleteMany({
    where: { user_id: { in: userIds } },
  });
  await authDb.passkeyCredential.deleteMany({
    where: { userId: { in: userIds } },
  });
  await authDb.trustedLoginDevice.deleteMany({
    where: { userId: { in: userIds } },
  });
  await authDb.zkLoginAttempt.deleteMany({
    where: { userId: { in: userIds } },
  });
  await authDb.email_verification_codes.deleteMany({
    where: { user_id: { in: userIds } },
  });
}

function roleCounts(users = []) {
  return users.reduce(
    (acc, user) => {
      const role =
        user.status === "disabled" || user.suspended
          ? "disabled"
          : normalizeRole(user.role);
      acc[role] = (acc[role] || 0) + 1;
      return acc;
    },
    { owner: 0, admin: 0, developer: 0, user: 0, disabled: 0 }
  );
}

async function main() {
  const authDb = client(authDatabaseUrl());
  const production = await readUsers("production");
  const development = await readUsers("development");
  const maps = { production: new Map(), development: new Map() };
  const index = { username: new Map(), email: new Map() };

  try {
    for (const user of await authDb.users.findMany()) {
      if (user.email) index.email.set(user.email, user);
      if (user.username)
        index.username.set(String(user.username).toLowerCase(), user);
    }

    for (const user of production.users) {
      await upsertAuthUser(authDb, user, "production", maps, index);
    }
    for (const user of development.users) {
      await upsertAuthUser(authDb, user, "development", maps, index);
    }

    if (dryRun) {
      const pendingUsers = [
        ...production.users.map((user) =>
          authDataFromEnvUser(user, "production")
        ),
        ...development.users.map((user) =>
          authDataFromEnvUser(user, "development")
        ),
      ];
      console.log(
        JSON.stringify(
          {
            success: true,
            dryRun: true,
            authDb: authDatabaseUrl().replace(/\\/g, "/"),
            productionUsers: production.users.length,
            developmentUsers: development.users.length,
            roleCounts: roleCounts(pendingUsers),
            ownerCount: pendingUsers.filter((user) => user.role === "owner")
              .length,
            ownerProtection: pendingUsers.some((user) => user.role === "owner"),
          },
          null,
          2
        )
      );
      return;
    }

    const productionBackfilled = await backfillEnvUsers(
      production,
      maps.production
    );
    const developmentBackfilled = await backfillEnvUsers(
      development,
      maps.development
    );
    await clearCopiedAuthTables(authDb, maps);
    const productionCopied = await copyAuthTables(
      authDb,
      production,
      maps.production
    );
    const developmentCopied = await copyAuthTables(
      authDb,
      development,
      maps.development
    );

    console.log(
      JSON.stringify(
        {
          success: true,
          authDb: authDatabaseUrl().replace(/\\/g, "/"),
          productionUsers: production.users.length,
          developmentUsers: development.users.length,
          productionBackfilled,
          developmentBackfilled,
          copiedAuthTables: {
            production: productionCopied,
            development: developmentCopied,
          },
          roleCounts: roleCounts(await authDb.users.findMany()),
          ownerProtection:
            (await authDb.users.count({
              where: { role: "owner", status: { not: "disabled" } },
            })) > 0,
        },
        null,
        2
      )
    );
  } finally {
    await authDb.$disconnect();
    if (production.db) await production.db.$disconnect();
    if (development.db) await development.db.$disconnect();
  }
}

main().catch((error) => {
  console.error(`[migrate-shared-auth-db] ${error.message}`);
  process.exit(1);
});
