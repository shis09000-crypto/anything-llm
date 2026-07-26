#!/usr/bin/env node
const {
  assertDatabaseSchema,
  assertPostgresqlSchema,
  bootstrapCliRuntime,
} = require("./lib/runtimeBootstrap");

const ROOT_TABLES = [
  "users",
  "user_root_key_epochs",
  "user_root_key_envelopes",
  "user_root_key_challenges",
  "_prisma_migrations",
];

async function summarize(client, now = new Date()) {
  if (client.$authPrismaReady) await client.$authPrismaReady;

  const [
    totalUsers,
    activeEpochs,
    retiredEpochs,
    pendingEnvelopes,
    expiredEnvelopes,
    consumedEnvelopes,
    outstandingChallenges,
    expiredChallenges,
  ] = await Promise.all([
    client.users.count(),
    client.user_root_key_epochs.findMany({
      where: { status: "active" },
      select: { authUserId: true },
    }),
    client.user_root_key_epochs.count({ where: { status: "retired" } }),
    client.user_root_key_envelopes.count({
      where: { consumedAt: null, expiresAt: { gt: now } },
    }),
    client.user_root_key_envelopes.count({
      where: { consumedAt: null, expiresAt: { lte: now } },
    }),
    client.user_root_key_envelopes.count({
      where: { consumedAt: { not: null } },
    }),
    client.user_root_key_challenges.count({
      where: { consumedAt: null, expiresAt: { gt: now } },
    }),
    client.user_root_key_challenges.count({
      where: { consumedAt: null, expiresAt: { lte: now } },
    }),
  ]);

  const initializedUsers = new Set(
    activeEpochs.map(({ authUserId }) => String(authUserId))
  ).size;

  return {
    users: {
      total: totalUsers,
      initialized: initializedUsers,
      notInitialized: Math.max(0, totalUsers - initializedUsers),
    },
    epochs: {
      active: activeEpochs.length,
      retired: retiredEpochs,
    },
    envelopes: {
      pending: pendingEnvelopes,
      expired: expiredEnvelopes,
      consumed: consumedEnvelopes,
    },
    challenges: {
      outstanding: outstandingChallenges,
      expired: expiredChallenges,
    },
  };
}

async function main() {
  const runtime = await bootstrapCliRuntime({
    requiredTables: ["users", "_prisma_migrations"],
  });
  const assertSchema =
    runtime.databaseProvider === "postgresql"
      ? ({ databaseUrl, ...options }) =>
          assertPostgresqlSchema({ databaseUrl, ...options })
      : ({ databasePath, ...options }) =>
          assertDatabaseSchema({ databasePath, ...options });

  await assertSchema({
    ...(runtime.databaseProvider === "postgresql"
      ? { databaseUrl: runtime.authDatabaseUrl }
      : { databasePath: runtime.authDatabasePath }),
    requiredTables: ROOT_TABLES,
    label: "auth",
  });

  const authPrisma = require("../utils/authPrisma");
  try {
    const state = await summarize(authPrisma);
    console.log(
      JSON.stringify(
        {
          success: true,
          environment: runtime.appEnv,
          database: "shared-auth",
          state,
        },
        null,
        2
      )
    );
  } finally {
    await authPrisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      JSON.stringify(
        {
          success: false,
          error: error.message,
          code: error.code || null,
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  });
}

module.exports = { main, summarize };
