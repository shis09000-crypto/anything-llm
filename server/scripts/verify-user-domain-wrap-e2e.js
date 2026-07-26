#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { bootstrapCliRuntime } = require("./lib/runtimeBootstrap");
const {
  canonicalJson,
  userDomainWrapAAD,
} = require("../utils/security/userDomainWrapping");
const {
  USER_ROOT_DERIVATION_SUITE_ID,
  USER_ROOT_TRANSPORT_SUITE_ID,
  deriveUserDomainKey,
} = require("../utils/security/userKeyDerivation");

const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const XWING_LABEL = Buffer.from("5c2e2f2f5e5c", "hex");

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function writePrivateJson(filePath, value) {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
  return target;
}

function rawPublic(key, bytes) {
  return Buffer.from(key.export({ format: "der", type: "spki" })).subarray(
    -bytes
  );
}

function targetXWingKeys() {
  const mlKem = crypto.generateKeyPairSync("ml-kem-768");
  const x25519 = crypto.generateKeyPairSync("x25519");
  return {
    mlKem,
    x25519,
    publicKey: Buffer.concat([
      rawPublic(mlKem.publicKey, 1184),
      rawPublic(x25519.publicKey, 32),
    ]),
  };
}

function openTransport(envelope, target) {
  const encapsulated = Buffer.from(envelope.encapsulatedKey, "base64url");
  const mlKemShared = crypto.decapsulate(
    target.mlKem.privateKey,
    encapsulated.subarray(0, 1088)
  );
  const ephemeralPublic = encapsulated.subarray(1088);
  const x25519Shared = crypto.diffieHellman({
    privateKey: target.x25519.privateKey,
    publicKey: crypto.createPublicKey({
      key: Buffer.concat([X25519_SPKI_PREFIX, ephemeralPublic]),
      format: "der",
      type: "spki",
    }),
  });
  const sharedKey = crypto
    .createHash("sha3-256")
    .update(
      Buffer.concat([
        Buffer.from(mlKemShared),
        x25519Shared,
        ephemeralPublic,
        rawPublic(target.x25519.publicKey, 32),
        XWING_LABEL,
      ])
    )
    .digest();
  const binding = {
    authUserId: envelope.authUserId,
    rootKeyId: envelope.rootKeyId,
    rootEpoch: envelope.rootEpoch,
    domainKeyVersion: envelope.domainKeyVersion,
    domain: envelope.domain,
    resourceType: envelope.resourceType,
    resourceId: envelope.resourceId,
    targetClientId: envelope.targetClientId,
    targetKeyGeneration: envelope.targetKeyGeneration,
    targetKEMPublicKey: envelope.targetKEMPublicKey,
  };
  const wrappingKey = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      sharedKey,
      Buffer.from("athena-user-domain-material-kem:v1", "utf8"),
      crypto
        .createHash("sha256")
        .update(
          `athena-user-domain-material-info:v1\u0000${canonicalJson(binding)}`,
          "utf8"
        )
        .digest(),
      32
    )
  );
  const sealed = Buffer.from(envelope.sealedKeyMaterial, "base64url");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    wrappingKey,
    sealed.subarray(0, 12)
  );
  decipher.setAAD(
    Buffer.from(
      `athena-user-domain-material-aad:v1\u0000${canonicalJson(binding)}`,
      "utf8"
    )
  );
  decipher.setAuthTag(sealed.subarray(-16));
  return Buffer.concat([
    decipher.update(sealed.subarray(12, -16)),
    decipher.final(),
  ]);
}

function wrapForRoot({
  keyMaterial,
  userRootKey,
  authUserId,
  rootEpoch,
  rootKeyId,
  domain,
  resourceType,
  resourceId,
}) {
  const metadata = {
    authUserId,
    rootKeyId,
    rootEpoch,
    domainKeyVersion: 1,
    domain,
    resourceType,
    resourceId,
  };
  const domainKey = deriveUserDomainKey({
    userRootKey,
    authUserId,
    keyEpoch: rootEpoch,
    domain,
  });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", domainKey, iv);
  cipher.setAAD(userDomainWrapAAD(metadata));
  const ciphertext = Buffer.concat([
    cipher.update(keyMaterial),
    cipher.final(),
  ]);
  return {
    version: "athena-user-domain-key-wrap:v1",
    algorithm: "aes-256-gcm",
    ...metadata,
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    keyCommitment: crypto
      .createHash("sha256")
      .update(keyMaterial)
      .digest("base64url"),
  };
}

async function main() {
  const runtime = await bootstrapCliRuntime({
    access: "write",
    execute: process.argv.includes("--execute"),
    requiredTables: [
      "users",
      "workspaces",
      "workspace_chat_conversation_keys",
      "content_objects",
      "vault_items",
      "user_domain_key_wraps",
      "_prisma_migrations",
    ],
  });
  if (runtime.appEnv !== "development")
    throw new Error("user_domain_e2e_development_only");
  if (Number(process.versions.node.split(".")[0]) !== 24)
    throw new Error("node24_xwing_runtime_required");

  const prisma = require("../utils/prisma");
  const authPrisma = require("../utils/authPrisma");
  const { encryptSecret } = require("../utils/security/encryption");
  const service = require("../utils/security/userDomainWrapService");
  const { migrateUser } = require("./migrate-user-domain-wraps");
  const suffix = crypto.randomUUID();
  const clientId = `user-domain-e2e:${suffix}`;
  const rootEpoch = 1;
  const userRootKey = crypto.randomBytes(32);
  const rootKeyId = crypto
    .createHash("sha256")
    .update(userRootKey)
    .digest("base64url");
  const ids = {
    username: `user-domain-e2e-${suffix}`,
    workspaceSlug: `user-domain-e2e-${suffix}`,
    conversationKey: `ck_${suffix}`,
    contentObject: `obj_${suffix}`,
    attachment: `att_${suffix}`,
    vaultItem: `vault_${suffix}`,
    vaultKey: `vmk_${suffix}`,
  };
  let authUser = null;
  let user = null;
  let workspace = null;
  let chat = null;
  try {
    authUser = await authPrisma.users.create({
      data: {
        username: ids.username,
        password: "e2e-non-login-credential",
        role: "user",
        status: "active",
        originEnv: "development",
        allowedEnvs: JSON.stringify(["development"]),
        ownerType: "individual",
      },
    });
    await authPrisma.user_root_key_epochs.create({
      data: {
        id: `urkepoch_${suffix}`,
        authUserId: authUser.id,
        rootEpoch,
        rootKeyId,
        derivationSuiteId: USER_ROOT_DERIVATION_SUITE_ID,
        transportSuiteId: USER_ROOT_TRANSPORT_SUITE_ID,
        initializedByClientId: clientId,
      },
    });
    user = await prisma.users.create({
      data: {
        authUserId: authUser.id,
        username: ids.username,
        password: "e2e-non-login-credential",
        role: "user",
        status: "active",
        originEnv: "development",
        allowedEnvs: JSON.stringify(["development"]),
        ownerType: "individual",
      },
    });
    workspace = await prisma.workspaces.create({
      data: { name: "User Domain E2E", slug: ids.workspaceSlug },
    });

    const conversationKey = crypto.randomBytes(32);
    const wrappedConversationKey = encryptSecret(
      conversationKey.toString("base64url")
    );
    await prisma.workspace_chat_conversation_keys.create({
      data: {
        key_id: ids.conversationKey,
        scope_hash: crypto.randomBytes(32).toString("hex"),
        workspace_id: workspace.id,
        user_id: user.id,
        wrapped_key: wrappedConversationKey,
      },
    });
    chat = await prisma.workspace_chats.create({
      data: {
        workspaceId: workspace.id,
        user_id: user.id,
        prompt: "e2e",
        response: "e2e",
      },
    });
    const contentDek = crypto.randomBytes(32);
    const wrappedDek = encryptSecret(contentDek.toString("base64url"), {
      purpose: "content-object-dek",
      domain: "content-object",
      resource: ids.contentObject,
    });
    await prisma.content_objects.create({
      data: {
        id: ids.contentObject,
        ownerType: "workspace",
        ownerId: String(workspace.id),
        domain: "chat-attachment",
        scopeHash: crypto.randomBytes(32).toString("hex"),
        dedupeKey: crypto.randomBytes(32).toString("hex"),
        plaintextSha256: crypto.randomBytes(32).toString("hex"),
        plaintextSize: 32,
        provider: "local",
        objectKey: `e2e/${ids.contentObject}.athobj`,
        ciphertextSha256: crypto.randomBytes(32).toString("hex"),
        encryptionVersion: "athena-content-object:v1",
        wrappedDek,
        encryptionMetadataJson: "{}",
        state: "ready",
        refCount: 1,
      },
    });
    await prisma.workspace_chat_attachment_refs.create({
      data: {
        id: ids.attachment,
        chatId: chat.id,
        contentObjectId: ids.contentObject,
        ordinal: 0,
        displayName: "e2e.bin",
        mimeType: "application/octet-stream",
        byteSize: 32,
      },
    });
    await prisma.vault_items.create({
      data: {
        itemId: ids.vaultItem,
        userId: user.id,
        keyId: ids.vaultKey,
        cryptoVersion: "athena-vault-item:v2",
        encryptedPayload: "client-opaque-e2e",
      },
    });

    const resources = [
      {
        resourceType: "chat-conversation-key",
        resourceId: ids.conversationKey,
        domain: "data",
        platformWrappedValue: wrappedConversationKey,
        expected: conversationKey,
      },
      {
        resourceType: "content-object",
        resourceId: ids.contentObject,
        domain: "file",
        platformWrappedValue: wrappedDek,
        expected: contentDek,
      },
      {
        resourceType: "vault-master-key",
        resourceId: ids.vaultKey,
        domain: "vault",
        platformWrapVersion: "vault-client:athena-vault-item:v2",
        platformKeyId: ids.vaultKey,
        expected: crypto.randomBytes(32),
        deviceMaterial: true,
      },
    ];
    const firstMigration = await migrateUser({
      prisma,
      services: service,
      user,
      root: {
        rootKeyId,
        rootEpoch,
      },
      batchSize: 50,
      apply: true,
    });
    const secondMigration = await migrateUser({
      prisma,
      services: service,
      user,
      root: {
        rootKeyId,
        rootEpoch,
      },
      batchSize: 50,
      apply: true,
    });
    const queuedWraps = await service.listUserDomainWraps({
      userId: user.id,
      authUserId: authUser.id,
      status: "pending",
      limit: 20,
    });
    if (
      queuedWraps.length !== 3 ||
      firstMigration.lanes.some(
        (lane) => lane.failed !== 0 || lane.done !== true
      ) ||
      secondMigration.lanes.some((lane) => lane.queued !== 0)
    )
      throw new Error("user_domain_e2e_migration_idempotency_failed");
    const target = targetXWingKeys();
    const completed = [];
    for (const resource of resources) {
      const queued = queuedWraps.find(
        (row) =>
          row.resourceType === resource.resourceType &&
          row.resourceId === resource.resourceId
      );
      if (!queued) throw new Error("user_domain_e2e_queue_failed");
      let keyMaterial = resource.expected;
      if (!resource.deviceMaterial) {
        const transport = await service.prepareUserDomainWrap({
          wrapId: queued.id,
          userId: user.id,
          authUserId: authUser.id,
          targetClientId: clientId,
          targetKeyGeneration: 1,
          targetKEMPublicKey: target.publicKey.toString("base64url"),
        });
        keyMaterial = openTransport(transport, target);
        if (!keyMaterial.equals(resource.expected))
          throw new Error("user_domain_e2e_transport_mismatch");
      }
      const envelope = wrapForRoot({
        keyMaterial,
        userRootKey,
        authUserId: authUser.id,
        rootEpoch,
        rootKeyId,
        domain: resource.domain,
        resourceType: resource.resourceType,
        resourceId: resource.resourceId,
      });
      const completedWrap = await service.completeUserDomainWrap({
        wrapId: queued.id,
        userId: user.id,
        authUserId: authUser.id,
        clientId,
        envelope,
      });
      const replayedWrap = await service.completeUserDomainWrap({
        wrapId: queued.id,
        userId: user.id,
        authUserId: authUser.id,
        clientId,
        envelope,
      });
      if (replayedWrap.status !== completedWrap.status)
        throw new Error("user_domain_e2e_completion_replay_failed");
      completed.push(completedWrap);
    }
    const coverage = await service.userDomainWrapCoverage({
      userId: user.id,
      authUserId: authUser.id,
    });
    if (
      coverage.eligible !== 3 ||
      coverage.active !== 3 ||
      coverage.pending !== 0 ||
      coverage.missing !== 0 ||
      coverage.coverage !== 1
    )
      throw new Error("user_domain_e2e_coverage_failed");
    const completedJobs = await prisma.user_domain_migration_jobs.findMany({
      where: { userId: user.id },
      orderBy: { resourceType: "asc" },
      select: {
        resourceType: true,
        status: true,
        scannedCount: true,
        queuedCount: true,
        completedCount: true,
        failedCount: true,
      },
    });
    if (
      completedJobs.length !== 3 ||
      completedJobs.some(
        (job) =>
          job.status !== "completed" ||
          job.queuedCount !== 1 ||
          job.completedCount !== 1 ||
          job.failedCount !== 0
      )
    )
      throw new Error("user_domain_e2e_migration_completion_failed");
    const result = {
      success: true,
      environment: runtime.appEnv,
      node: process.version,
      resources: completed.map((row) => ({
        resourceType: row.resourceType,
        domain: row.domain,
        wrapVersion: row.wrapVersion,
        rootKeyId: row.rootKeyId,
        domainKeyVersion: row.domainKeyVersion,
        platformWrapVersion: row.platformWrapVersion,
        status: row.status,
      })),
      coverage,
      compatibility: {
        platformEncV2Read: true,
        xwingTransport: true,
        ciphertextRewritten: false,
      },
      migration: {
        firstPass: firstMigration.lanes,
        idempotentSecondPass: secondMigration.lanes,
        completedJobs,
      },
    };
    const outputPath = arg("--output");
    if (outputPath) {
      result.outputPath = writePrivateJson(outputPath, result);
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (user) {
      await prisma.user_domain_key_wraps.deleteMany({
        where: { userId: user.id },
      });
      await prisma.user_domain_migration_jobs.deleteMany({
        where: { userId: user.id },
      });
      await prisma.vault_items.deleteMany({ where: { userId: user.id } });
    }
    if (chat) {
      await prisma.workspace_chat_attachment_refs.deleteMany({
        where: { chatId: chat.id },
      });
      await prisma.workspace_chats.deleteMany({ where: { id: chat.id } });
    }
    await prisma.content_objects.deleteMany({
      where: { id: ids.contentObject },
    });
    await prisma.workspace_chat_conversation_keys.deleteMany({
      where: { key_id: ids.conversationKey },
    });
    if (workspace) {
      await prisma.workspaces.deleteMany({ where: { id: workspace.id } });
    }
    if (user) await prisma.users.deleteMany({ where: { id: user.id } });
    if (authUser) {
      await authPrisma.user_root_key_epochs.deleteMany({
        where: { authUserId: authUser.id },
      });
      await authPrisma.users.deleteMany({ where: { id: authUser.id } });
    }
    await Promise.allSettled([prisma.$disconnect(), authPrisma.$disconnect()]);
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      { success: false, error: error?.message || String(error) },
      null,
      2
    )
  );
  process.exitCode = 1;
});
