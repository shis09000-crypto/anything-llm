const REQUIRED_MODELS = {
  athena_clients: [
    "clientId",
    "userId",
    "publicKey",
    "publicKeyAlgorithm",
    "publicKeyParameterSet",
    "publicKeyOrigin",
    "publicKeyHardwareProtection",
    "pqPublicKey",
    "hybridKemPublicKey",
    "vaultSigningP256PublicKey",
    "attestationStatus",
    "pendingPublicKey",
  ],
  athena_device_attestation_challenges: ["id", "userId", "clientId", "status"],
  user_root_key_epochs: ["id", "authUserId", "rootEpoch", "rootKeyId"],
  user_domain_key_wraps: [
    "id",
    "authUserId",
    "resourceType",
    "resourceId",
    "domain",
  ],
  chat_stream_runs: ["id", "clientTurnId", "workspaceId", "status", "revision"],
};

function validateDmmfContract(datamodel) {
  const models = new Map(
    (datamodel?.models || []).map((model) => [
      model.name,
      new Set((model.fields || []).map((field) => field.name)),
    ])
  );
  const missing = [];

  for (const [modelName, requiredFields] of Object.entries(REQUIRED_MODELS)) {
    const fields = models.get(modelName);
    if (!fields) {
      missing.push(`${modelName}.*`);
      continue;
    }
    for (const field of requiredFields) {
      if (!fields.has(field)) missing.push(`${modelName}.${field}`);
    }
  }

  if (missing.length > 0) {
    const error = new Error(
      `Generated Prisma client is missing required runtime contract entries: ${missing.join(
        ", "
      )}`
    );
    error.code = "PRISMA_RUNTIME_CONTRACT_MISMATCH";
    throw error;
  }
}

async function verifyDatabaseContract(label, client) {
  await client.athena_clients.findFirst({
    select: Object.fromEntries(
      REQUIRED_MODELS.athena_clients.map((field) => [field, true])
    ),
  });
  await client.user_root_key_epochs.findFirst({
    select: Object.fromEntries(
      REQUIRED_MODELS.user_root_key_epochs.map((field) => [field, true])
    ),
  });
  await client.user_domain_key_wraps.findFirst({
    select: Object.fromEntries(
      REQUIRED_MODELS.user_domain_key_wraps.map((field) => [field, true])
    ),
  });

  if (label === "main") {
    await client.athena_device_attestation_challenges.findFirst({
      select: Object.fromEntries(
        REQUIRED_MODELS.athena_device_attestation_challenges.map((field) => [
          field,
          true,
        ])
      ),
    });
    await client.chat_stream_runs.findFirst({
      select: Object.fromEntries(
        REQUIRED_MODELS.chat_stream_runs.map((field) => [field, true])
      ),
    });
  }
}

async function main() {
  const { Prisma } = require("@prisma/client");
  validateDmmfContract(Prisma.dmmf.datamodel);

  const prisma = require("../utils/prisma");
  const authPrisma = require("../utils/authPrisma");
  try {
    await Promise.all([
      prisma.$prismaReady || Promise.resolve(true),
      authPrisma.$authPrismaReady || Promise.resolve(true),
    ]);
    await verifyDatabaseContract("main", prisma);
    await verifyDatabaseContract("auth", authPrisma);
    console.log(
      "[PrismaContract] Generated client and main/auth databases are compatible."
    );
  } finally {
    await Promise.allSettled([prisma.$disconnect(), authPrisma.$disconnect()]);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[PrismaContract] Verification failed:", error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  REQUIRED_MODELS,
  validateDmmfContract,
  verifyDatabaseContract,
};
