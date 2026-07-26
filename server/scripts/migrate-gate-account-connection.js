#!/usr/bin/env node
const crypto = require("crypto");
const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");

function hasArg(name) {
  return process.argv.includes(name);
}

function fingerprint(apiKey, apiSecret) {
  return crypto
    .createHash("sha256")
    .update(`${String(apiKey || "")}\u0000${String(apiSecret || "")}`)
    .digest("hex")
    .slice(0, 16);
}

async function uniquePrimaryOwner(prisma) {
  const primary = await prisma.users.findMany({
    where: { status: "active", ownerType: "primary" },
    select: {
      id: true,
      authUserId: true,
      role: true,
      ownerType: true,
    },
    take: 2,
  });
  if (primary.length !== 1 || !primary[0].authUserId) {
    const error = new Error("unique_primary_owner_required");
    error.details = { activePrimaryOwnerCount: primary.length };
    throw error;
  }
  return primary[0];
}

async function main() {
  const apply = hasArg("--apply") && hasArg("--execute");
  const runtime = await bootstrapCliRuntime({
    access: apply ? "write" : "read",
    execute: apply,
    requiredTables: [
      "crypto_account_connections",
      "user_domain_key_wraps",
      "user_root_key_epochs",
      "_prisma_migrations",
    ],
  });
  const prisma = require("../utils/prisma");
  const authPrisma = require("../utils/authPrisma");
  await Promise.all([prisma.$prismaReady, authPrisma.$authPrismaReady]);
  const {
    getGateConfigStatus,
    getGateCredentials,
  } = require("../utils/cryptoGate");
  const status = getGateConfigStatus();
  if (
    !status.enabled ||
    !status.readOnly ||
    !status.hasApiKey ||
    !status.hasApiSecret ||
    status.configError
  ) {
    throw new Error("gate_readonly_credentials_required");
  }
  const credentials = getGateCredentials();
  const nextFingerprint = fingerprint(
    credentials.apiKey,
    credentials.apiSecret
  );
  const owner = await uniquePrimaryOwner(prisma);
  const root = await authPrisma.user_root_key_epochs.findFirst({
    where: { authUserId: owner.authUserId, status: "active" },
    orderBy: { rootEpoch: "desc" },
  });
  if (!root) throw new Error("primary_owner_root_not_initialized");
  const existing = await prisma.crypto_account_connections.findUnique({
    where: {
      authUserId_provider_environment: {
        authUserId: owner.authUserId,
        provider: "gate",
        environment: status.env || "production",
      },
    },
    select: {
      id: true,
      status: true,
      credentialVersion: true,
      credentialFingerprint: true,
      rootKeyId: true,
      domainKeyVersion: true,
    },
  });
  if (!apply) {
    console.log(
      JSON.stringify(
        {
          success: true,
          mode: "dry-run",
          environment: runtime.appEnv,
          eligible: true,
          owner: {
            ownerType: owner.ownerType,
          },
          root: {
            initialized: true,
          },
          gate: {
            enabled: status.enabled,
            environment: status.env,
            readOnly: status.readOnly,
            configured: status.hasApiKey && status.hasApiSecret,
            fingerprint: nextFingerprint,
          },
          existing: existing
            ? {
                status: existing.status,
                credentialVersion: existing.credentialVersion,
                fingerprint: existing.credentialFingerprint,
              }
            : null,
          next: "Repeat with --apply --execute to create the account envelope and queue the User Agent domain wrap.",
        },
        null,
        2
      )
    );
    return;
  }
  if (
    existing &&
    existing.credentialFingerprint === nextFingerprint &&
    existing.rootKeyId === root.rootKeyId
  ) {
    console.log(
      JSON.stringify(
        {
          success: true,
          mode: "applied",
          idempotent: true,
          environment: runtime.appEnv,
          connection: {
            status: existing.status,
            credentialVersion: existing.credentialVersion,
            fingerprint: existing.credentialFingerprint,
            domainKeyVersion: existing.domainKeyVersion,
          },
          deviceWrapRequired: existing.status !== "active",
        },
        null,
        2
      )
    );
    return;
  }
  const { createOrRotateConnection } = require("../utils/cryptoAccount");
  const result = await createOrRotateConnection({
    user: owner,
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    environment: credentials.env,
    provider: "gate",
  });
  console.log(
    JSON.stringify(
      {
        success: true,
        mode: "applied",
        idempotent: false,
        environment: runtime.appEnv,
        connection: {
          status: result.connection.status,
          credentialVersion: result.connection.credentialVersion,
          fingerprint: result.connection.credentialFingerprint,
          domainKeyVersion: result.connection.domainKeyVersion,
        },
        wrap: {
          status: result.wrap.status,
          wrapVersion: result.wrap.wrapVersion,
          domain: result.wrap.domain,
          resourceType: result.wrap.resourceType,
        },
        deviceWrapRequired: true,
        legacyFallbackRetained: true,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
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
  })
  .finally(async () => {
    await Promise.allSettled([
      require("../utils/prisma").$disconnect(),
      require("../utils/authPrisma").$disconnect(),
    ]);
  });
