#!/usr/bin/env node
const path = require("path");
const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name.toLowerCase()}_required`);
  return value;
}

async function main() {
  const runtime = await bootstrapCliRuntime({
    requiredTables: ["users", "system_settings", "_prisma_migrations"],
  });
  if (
    process.env.ATHENA_USER_ROOT_E2E_ALLOW !== "true" ||
    !path.basename(runtime.storageBase).startsWith("athena-user-root-e2e-")
  ) {
    throw new Error("isolated_user_root_e2e_storage_required");
  }

  const username = required("ATHENA_USER_ROOT_E2E_USERNAME");
  const password = required("ATHENA_USER_ROOT_E2E_PASSWORD");
  const prisma = require("../utils/prisma");
  const authPrisma = require("../utils/authPrisma");
  const { User } = require("../models/user");
  try {
    const existing = await authPrisma.users.findFirst({
      where: { username },
      select: { id: true },
    });
    if (existing) throw new Error("user_root_e2e_user_already_exists");

    await Promise.all([
      prisma.system_settings.upsert({
        where: { label: "multi_user_mode" },
        update: { value: "true" },
        create: { label: "multi_user_mode", value: "true" },
      }),
      prisma.system_settings.upsert({
        where: { label: "onboarding_complete" },
        update: { value: "true" },
        create: { label: "onboarding_complete", value: "true" },
      }),
    ]);
    const { user, error } = await User.create({
      username,
      password,
      role: "user",
      status: "active",
      allowedEnvs: ["development"],
      originEnv: "development",
      ownerType: "individual",
    });
    if (!user) throw new Error(error || "user_root_e2e_user_create_failed");

    console.log(
      JSON.stringify(
        {
          success: true,
          environment: runtime.appEnv,
          isolatedStorage: runtime.storageBase,
          user: {
            id: user.id,
            authUserId: user.authUserId,
            username: user.username,
          },
        },
        null,
        2
      )
    );
  } finally {
    await Promise.allSettled([prisma.$disconnect(), authPrisma.$disconnect()]);
  }
}

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
