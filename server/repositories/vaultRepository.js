const { VaultItem } = require("../models/vaultItem");
const prisma = require("../utils/prisma");
const authPrisma = require("../utils/authPrisma");
const crypto = require("crypto");
const {
  assertUserScope,
  sanitizeValue,
} = require("../utils/dataAccess/dataAccessPolicy");
const {
  USER_ROOT_DERIVATION_SUITE_ID,
  USER_ROOT_ENVELOPE_VERSION,
  USER_ROOT_TRANSPORT_SUITE_ID,
} = require("../utils/security/userKeyDerivation");
const {
  advanceMigrationJob,
  completeUserDomainWrap,
  createOrResumeMigrationJob,
  listUserDomainWraps,
  prepareUserDomainWrap,
  queueUserDomainWrap,
  userDomainWrapCoverage,
} = require("../utils/security/userDomainWrapService");

const ENVELOPE_RATE_WINDOW_MS = 60 * 60 * 1000;
const ENVELOPE_RATE_LIMIT = 120;
const EPOCH_ROTATION_MIN_INTERVAL_MS = 5 * 60 * 1000;
const USER_ROOT_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const USER_ROOT_CHALLENGE_RATE_LIMIT = 30;
const USER_ROOT_ENVELOPE_TTL_MS = 10 * 60 * 1000;

function vaultId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function normalizedAuthUserId(value, operation) {
  return assertUserScope(value, operation);
}

function normalizedRootEnvelope({
  authUserId,
  sourceClientId,
  targetClientId,
  sourceKeyGeneration,
  targetKeyGeneration,
  rootEpoch,
  envelope,
} = {}) {
  const ownerId = normalizedAuthUserId(authUserId, "vault.userRootEnvelope");
  const source = String(sourceClientId || "").trim();
  const target = String(targetClientId || "").trim();
  const sourceGeneration = Number(sourceKeyGeneration);
  const targetGeneration = Number(targetKeyGeneration);
  const epoch = Number(rootEpoch);
  const envelopeJson = JSON.stringify(envelope || {});
  const challenge = String(envelope?.challenge || "");
  const challengeData = /^[A-Za-z0-9_-]{43}$/.test(challenge)
    ? Buffer.from(challenge, "base64url")
    : null;
  const challengeHash = challengeData
    ? base64Url(crypto.createHash("sha256").update(challengeData).digest())
    : null;
  const createdAt = new Date(envelope?.createdAt || "");
  const expiresAt = new Date(envelope?.expiresAt || "");
  const now = Date.now();
  if (
    !/^[A-Za-z0-9._:-]{1,256}$/.test(source) ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(target)
  )
    throw new Error("user_root_client_id_invalid");
  if (
    !Number.isSafeInteger(sourceGeneration) ||
    sourceGeneration < 1 ||
    !Number.isSafeInteger(targetGeneration) ||
    targetGeneration < 1
  )
    throw new Error("user_root_key_generation_invalid");
  if (!Number.isSafeInteger(epoch) || epoch < 1)
    throw new Error("user_root_epoch_invalid");
  if (
    envelope?.version !== USER_ROOT_ENVELOPE_VERSION ||
    envelope?.materialType !== "user-root-key" ||
    envelope?.derivationSuiteId !== USER_ROOT_DERIVATION_SUITE_ID ||
    envelope?.transportSuiteId !== USER_ROOT_TRANSPORT_SUITE_ID ||
    Number(envelope?.authUserId) !== ownerId ||
    Number(envelope?.rootEpoch) !== epoch ||
    envelope?.sourceClientId !== source ||
    envelope?.targetClientId !== target ||
    Number(envelope?.sourceKeyGeneration) !== sourceGeneration ||
    Number(envelope?.targetKeyGeneration) !== targetGeneration ||
    !/^[A-Za-z0-9_-]{43}$/.test(String(envelope?.rootKeyId || "")) ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(String(envelope?.challengeId || "")) ||
    challengeData?.length !== 32 ||
    base64Url(challengeData) !== challenge ||
    !/^[A-Za-z0-9_-]{43}$/.test(String(envelope?.challengeSHA256 || "")) ||
    challengeHash !== envelope?.challengeSHA256 ||
    !Number.isFinite(createdAt.getTime()) ||
    !Number.isFinite(expiresAt.getTime())
  )
    throw new Error("user_root_envelope_invalid");
  if (
    createdAt.getTime() > now + 60_000 ||
    expiresAt.getTime() <= now ||
    expiresAt.getTime() <= createdAt.getTime() ||
    expiresAt.getTime() - createdAt.getTime() > USER_ROOT_ENVELOPE_TTL_MS
  )
    throw new Error("user_root_envelope_expired");
  if (envelopeJson.length < 256 || envelopeJson.length > 128 * 1024)
    throw new Error("user_root_envelope_size_invalid");
  return {
    ownerId,
    source,
    target,
    sourceGeneration,
    targetGeneration,
    epoch,
    rootKeyId: envelope.rootKeyId,
    envelopeJson,
    expiresAt,
  };
}

async function consumeUserRootChallenge(
  tx,
  {
    challengeId,
    challengeHash,
    authUserId,
    sourceClientId,
    targetClientId,
    purpose,
  }
) {
  const result = await tx.user_root_key_challenges.updateMany({
    where: {
      id: String(challengeId || ""),
      authUserId,
      sourceClientId,
      targetClientId,
      purpose,
      challengeHash: String(challengeHash || ""),
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { consumedAt: new Date() },
  });
  if (result.count !== 1) throw new Error("user_root_challenge_invalid");
}

function encryptedPayloadEnvelope(payload = null) {
  if (!payload || typeof payload !== "object") return null;
  return {
    cryptoVersion: payload.cryptoVersion || null,
    algorithm: payload.algorithm || null,
    keyId: payload.keyId || null,
    hasWrappedItemKey: Boolean(payload.wrappedItemKey),
    hasIv: Boolean(payload.iv),
    hasCiphertext: Boolean(payload.ciphertext),
  };
}

function vaultItemEnvelope(
  item = null,
  { includeEncryptedPayload = false } = {}
) {
  if (!item) return null;
  return {
    id: item.itemId || item.id,
    itemId: item.itemId || item.id,
    itemType: item.itemType,
    label: item.label || null,
    keyId: item.keyId || null,
    cryptoVersion: item.cryptoVersion || null,
    metadata: sanitizeValue(item.metadata || {}),
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null,
    ...(includeEncryptedPayload
      ? { encryptedPayload: encryptedPayloadEnvelope(item.encryptedPayload) }
      : {}),
  };
}

const VaultRepository = {
  dataDomain: "vault",
  repositoryName: "VaultRepository",

  async listItems({ userId, itemType = null } = {}) {
    const ownerId = assertUserScope(userId, "vault.listItems");
    return VaultItem.list({ userId: ownerId, itemType });
  },

  async list({ userId, itemType = null } = {}) {
    const ownerId = assertUserScope(userId, "vault.list");
    const items = await VaultItem.list({ userId: ownerId, itemType });
    return items.map((item) => vaultItemEnvelope(item));
  },

  async getItem({ userId, itemId, includeEncryptedPayload = true } = {}) {
    const ownerId = assertUserScope(userId, "vault.getItem");
    return VaultItem.get({
      userId: ownerId,
      itemId,
      includeEncryptedPayload,
    });
  },

  async getEnvelope({ userId, itemId, includeEncryptedPayload = true } = {}) {
    const ownerId = assertUserScope(userId, "vault.getEnvelope");
    const item = await VaultItem.get({
      userId: ownerId,
      itemId,
      includeEncryptedPayload,
    });
    return vaultItemEnvelope(item, { includeEncryptedPayload });
  },

  async createOrUpdateItem(options = {}) {
    const ownerId = assertUserScope(options.userId, "vault.createOrUpdateItem");
    return VaultItem.createOrUpdate({
      ...options,
      userId: ownerId,
    });
  },

  async createOrUpdateEnvelope(options = {}) {
    const ownerId = assertUserScope(options.userId, "vault.createOrUpdate");
    const item = await VaultItem.createOrUpdate({
      ...options,
      userId: ownerId,
    });
    return vaultItemEnvelope(item, { includeEncryptedPayload: true });
  },

  async deleteItem({ userId, itemId } = {}) {
    const ownerId = assertUserScope(userId, "vault.deleteItem");
    return VaultItem.delete({ userId: ownerId, itemId });
  },

  async softDelete({ userId, itemId } = {}) {
    const ownerId = assertUserScope(userId, "vault.softDelete");
    return VaultItem.delete({ userId: ownerId, itemId });
  },

  async snapshot({ userId } = {}) {
    const ownerId = assertUserScope(userId, "vault.snapshot");
    const items = await this.list({ userId: ownerId });
    return {
      userId: ownerId,
      count: items.length,
      byType: items.reduce((acc, item) => {
        acc[item.itemType] = (acc[item.itemType] || 0) + 1;
        return acc;
      }, {}),
      items,
    };
  },

  async queueUserDomainWrap(options = {}) {
    const userId = assertUserScope(options.userId, "vault.queueUserDomainWrap");
    return queueUserDomainWrap({ ...options, userId });
  },

  async listUserDomainWraps(options = {}) {
    const userId = assertUserScope(options.userId, "vault.listUserDomainWraps");
    return listUserDomainWraps({ ...options, userId });
  },

  async prepareUserDomainWrap(options = {}) {
    const userId = assertUserScope(
      options.userId,
      "vault.prepareUserDomainWrap"
    );
    return prepareUserDomainWrap({ ...options, userId });
  },

  async completeUserDomainWrap(options = {}) {
    const userId = assertUserScope(
      options.userId,
      "vault.completeUserDomainWrap"
    );
    return completeUserDomainWrap({ ...options, userId });
  },

  async createOrResumeUserDomainMigration(options = {}) {
    const userId = assertUserScope(
      options.userId,
      "vault.createOrResumeUserDomainMigration"
    );
    return createOrResumeMigrationJob({ ...options, userId });
  },

  async advanceUserDomainMigration(options = {}) {
    return advanceMigrationJob(options);
  },

  async userDomainWrapCoverage(options = {}) {
    const userId = options.userId
      ? assertUserScope(options.userId, "vault.userDomainWrapCoverage")
      : null;
    return userDomainWrapCoverage({ ...options, userId });
  },

  async userRootStatus({ authUserId, targetClientId = null } = {}) {
    const ownerId = normalizedAuthUserId(authUserId, "vault.userRootStatus");
    const [epoch, pendingEnvelopes] = await Promise.all([
      authPrisma.user_root_key_epochs.findFirst({
        where: { authUserId: ownerId, status: "active" },
        orderBy: { rootEpoch: "desc" },
      }),
      targetClientId
        ? authPrisma.user_root_key_envelopes.count({
            where: {
              authUserId: ownerId,
              targetClientId: String(targetClientId),
              consumedAt: null,
              expiresAt: { gt: new Date() },
            },
          })
        : 0,
    ]);
    return {
      initialized: Boolean(epoch),
      rootEpoch: epoch?.rootEpoch || null,
      rootKeyId: epoch?.rootKeyId || null,
      derivationSuiteId: epoch?.derivationSuiteId || null,
      transportSuiteId: epoch?.transportSuiteId || null,
      status: epoch?.status || "not_initialized",
      initializedByClientId: epoch?.initializedByClientId || null,
      pendingEnvelopes,
    };
  },

  async issueUserRootChallenge({
    authUserId,
    sourceClientId,
    targetClientId,
    purpose,
  } = {}) {
    const ownerId = normalizedAuthUserId(
      authUserId,
      "vault.issueUserRootChallenge"
    );
    const source = String(sourceClientId || "").trim();
    const target = String(targetClientId || "").trim();
    const normalizedPurpose = String(purpose || "").trim();
    if (!["initialize", "authorize"].includes(normalizedPurpose))
      throw new Error("user_root_challenge_purpose_invalid");
    if (
      !/^[A-Za-z0-9._:-]{1,256}$/.test(source) ||
      !/^[A-Za-z0-9._:-]{1,256}$/.test(target)
    )
      throw new Error("user_root_client_id_invalid");
    const active = await authPrisma.user_root_key_epochs.findFirst({
      where: { authUserId: ownerId, status: "active" },
      orderBy: { rootEpoch: "desc" },
    });
    if (normalizedPurpose === "initialize" && active)
      throw new Error("user_root_already_initialized");
    if (normalizedPurpose === "initialize" && source !== target)
      throw new Error("user_root_initialization_target_invalid");
    if (normalizedPurpose === "authorize" && !active)
      throw new Error("user_root_not_initialized");
    const recentChallenges = await authPrisma.user_root_key_challenges.count({
      where: {
        authUserId: ownerId,
        sourceClientId: source,
        createdAt: {
          gt: new Date(Date.now() - ENVELOPE_RATE_WINDOW_MS),
        },
      },
    });
    if (recentChallenges >= USER_ROOT_CHALLENGE_RATE_LIMIT)
      throw new Error("user_root_challenge_rate_limited");

    const challenge = crypto.randomBytes(32);
    const challengeHash = base64Url(
      crypto.createHash("sha256").update(challenge).digest()
    );
    const expiresAt = new Date(Date.now() + USER_ROOT_CHALLENGE_TTL_MS);
    const record = await authPrisma.user_root_key_challenges.create({
      data: {
        id: vaultId("urkchallenge"),
        authUserId: ownerId,
        sourceClientId: source,
        targetClientId: target,
        purpose: normalizedPurpose,
        challengeHash,
        expiresAt,
      },
    });
    return {
      challengeId: record.id,
      challenge: base64Url(challenge),
      challengeHash,
      purpose: normalizedPurpose,
      targetClientId: target,
      rootEpoch: active?.rootEpoch || 1,
      rootKeyId: active?.rootKeyId || null,
      expiresAt,
    };
  },

  async initializeUserRoot({
    authUserId,
    sourceClientId,
    targetClientId,
    sourceKeyGeneration,
    targetKeyGeneration,
    rootEpoch,
    challengeId,
    envelope,
  } = {}) {
    const normalized = normalizedRootEnvelope({
      authUserId,
      sourceClientId,
      targetClientId,
      sourceKeyGeneration,
      targetKeyGeneration,
      rootEpoch,
      envelope,
    });
    if (
      normalized.epoch !== 1 ||
      normalized.source !== normalized.target ||
      envelope?.challengeId !== challengeId
    )
      throw new Error("user_root_initialization_invalid");

    return authPrisma.$transaction(async (tx) => {
      const existingEpoch = await tx.user_root_key_epochs.findFirst({
        where: { authUserId: normalized.ownerId, status: "active" },
        orderBy: { rootEpoch: "desc" },
      });
      if (existingEpoch) {
        const existingEnvelope = await tx.user_root_key_envelopes.findUnique({
          where: {
            authUserId_targetClientId_targetKeyGeneration_rootEpoch: {
              authUserId: normalized.ownerId,
              targetClientId: normalized.target,
              targetKeyGeneration: normalized.targetGeneration,
              rootEpoch: normalized.epoch,
            },
          },
        });
        if (
          existingEpoch.rootKeyId === normalized.rootKeyId &&
          existingEnvelope?.envelopeJson === normalized.envelopeJson
        )
          return {
            epoch: existingEpoch,
            envelope: existingEnvelope,
            initialized: false,
          };
        throw new Error("user_root_already_initialized");
      }
      await consumeUserRootChallenge(tx, {
        challengeId,
        challengeHash: envelope.challengeSHA256,
        authUserId: normalized.ownerId,
        sourceClientId: normalized.source,
        targetClientId: normalized.target,
        purpose: "initialize",
      });
      const epoch = await tx.user_root_key_epochs.create({
        data: {
          id: vaultId("urkepoch"),
          authUserId: normalized.ownerId,
          rootEpoch: normalized.epoch,
          rootKeyId: normalized.rootKeyId,
          derivationSuiteId: USER_ROOT_DERIVATION_SUITE_ID,
          transportSuiteId: USER_ROOT_TRANSPORT_SUITE_ID,
          initializedByClientId: normalized.source,
        },
      });
      const storedEnvelope = await tx.user_root_key_envelopes.create({
        data: {
          id: vaultId("urkenvelope"),
          authUserId: normalized.ownerId,
          sourceClientId: normalized.source,
          targetClientId: normalized.target,
          sourceKeyGeneration: normalized.sourceGeneration,
          targetKeyGeneration: normalized.targetGeneration,
          rootEpoch: normalized.epoch,
          rootKeyId: normalized.rootKeyId,
          derivationSuiteId: USER_ROOT_DERIVATION_SUITE_ID,
          transportSuiteId: USER_ROOT_TRANSPORT_SUITE_ID,
          envelopeVersion: USER_ROOT_ENVELOPE_VERSION,
          envelopeJson: normalized.envelopeJson,
          expiresAt: normalized.expiresAt,
          consumedAt: new Date(),
        },
      });
      return { epoch, envelope: storedEnvelope, initialized: true };
    });
  },

  async storeUserRootEnvelope({
    authUserId,
    sourceClientId,
    targetClientId,
    sourceKeyGeneration,
    targetKeyGeneration,
    rootEpoch,
    challengeId,
    envelope,
  } = {}) {
    const normalized = normalizedRootEnvelope({
      authUserId,
      sourceClientId,
      targetClientId,
      sourceKeyGeneration,
      targetKeyGeneration,
      rootEpoch,
      envelope,
    });
    if (envelope?.challengeId !== challengeId)
      throw new Error("user_root_challenge_invalid");
    return authPrisma.$transaction(async (tx) => {
      const active = await tx.user_root_key_epochs.findUnique({
        where: {
          authUserId_rootEpoch: {
            authUserId: normalized.ownerId,
            rootEpoch: normalized.epoch,
          },
        },
      });
      if (
        !active ||
        active.status !== "active" ||
        active.rootKeyId !== normalized.rootKeyId ||
        active.derivationSuiteId !== USER_ROOT_DERIVATION_SUITE_ID ||
        active.transportSuiteId !== USER_ROOT_TRANSPORT_SUITE_ID
      )
        throw new Error("user_root_epoch_mismatch");
      const existing = await tx.user_root_key_envelopes.findUnique({
        where: {
          authUserId_targetClientId_targetKeyGeneration_rootEpoch: {
            authUserId: normalized.ownerId,
            targetClientId: normalized.target,
            targetKeyGeneration: normalized.targetGeneration,
            rootEpoch: normalized.epoch,
          },
        },
      });
      if (existing) {
        if (
          existing.sourceClientId === normalized.source &&
          existing.envelopeJson === normalized.envelopeJson
        )
          return existing;
        throw new Error("user_root_envelope_conflict");
      }
      await consumeUserRootChallenge(tx, {
        challengeId,
        challengeHash: envelope.challengeSHA256,
        authUserId: normalized.ownerId,
        sourceClientId: normalized.source,
        targetClientId: normalized.target,
        purpose: "authorize",
      });
      return tx.user_root_key_envelopes.create({
        data: {
          id: vaultId("urkenvelope"),
          authUserId: normalized.ownerId,
          sourceClientId: normalized.source,
          targetClientId: normalized.target,
          sourceKeyGeneration: normalized.sourceGeneration,
          targetKeyGeneration: normalized.targetGeneration,
          rootEpoch: normalized.epoch,
          rootKeyId: normalized.rootKeyId,
          derivationSuiteId: USER_ROOT_DERIVATION_SUITE_ID,
          transportSuiteId: USER_ROOT_TRANSPORT_SUITE_ID,
          envelopeVersion: USER_ROOT_ENVELOPE_VERSION,
          envelopeJson: normalized.envelopeJson,
          expiresAt: normalized.expiresAt,
        },
      });
    });
  },

  async pendingUserRootEnvelopes({ authUserId, targetClientId } = {}) {
    const ownerId = normalizedAuthUserId(
      authUserId,
      "vault.pendingUserRootEnvelopes"
    );
    const rows = await authPrisma.user_root_key_envelopes.findMany({
      where: {
        authUserId: ownerId,
        targetClientId: String(targetClientId),
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "asc" },
      take: 20,
    });
    return rows.map((row) => ({
      id: row.id,
      sourceClientId: row.sourceClientId,
      targetClientId: row.targetClientId,
      sourceKeyGeneration: row.sourceKeyGeneration,
      targetKeyGeneration: row.targetKeyGeneration,
      rootEpoch: row.rootEpoch,
      rootKeyId: row.rootKeyId,
      envelope: JSON.parse(row.envelopeJson),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    }));
  },

  async consumeUserRootEnvelope({
    authUserId,
    targetClientId,
    targetKeyGeneration,
    envelopeId,
  } = {}) {
    const ownerId = normalizedAuthUserId(
      authUserId,
      "vault.consumeUserRootEnvelope"
    );
    const generation = Number(targetKeyGeneration);
    if (!Number.isSafeInteger(generation) || generation < 1)
      throw new Error("user_root_key_generation_invalid");
    const result = await authPrisma.user_root_key_envelopes.updateMany({
      where: {
        id: String(envelopeId),
        authUserId: ownerId,
        targetClientId: String(targetClientId),
        targetKeyGeneration: generation,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { consumedAt: new Date() },
    });
    if (result.count === 1) return true;
    const alreadyConsumed = await authPrisma.user_root_key_envelopes.findFirst({
      where: {
        id: String(envelopeId),
        authUserId: ownerId,
        targetClientId: String(targetClientId),
        targetKeyGeneration: generation,
        consumedAt: { not: null },
      },
      select: { id: true },
    });
    return Boolean(alreadyConsumed);
  },

  async storeDeviceKeyEnvelope({
    userId,
    sourceClientId,
    targetClientId,
    sourceKeyGeneration = 1,
    targetKeyGeneration = 1,
    keyEpoch,
    envelope,
  } = {}) {
    const ownerId = assertUserScope(userId, "vault.storeDeviceKeyEnvelope");
    const normalizedEpoch = Number(keyEpoch);
    const envelopeJson = JSON.stringify(envelope || {});
    if (!Number.isSafeInteger(normalizedEpoch) || normalizedEpoch < 1)
      throw new Error("vault_key_epoch_invalid");
    if (envelopeJson.length > 128 * 1024)
      throw new Error("vault_key_envelope_too_large");
    const target = String(targetClientId);
    const source = String(sourceClientId);
    const normalizedSourceGeneration = Number(sourceKeyGeneration);
    const normalizedTargetGeneration = Number(targetKeyGeneration);
    if (
      !Number.isSafeInteger(normalizedSourceGeneration) ||
      normalizedSourceGeneration < 1 ||
      !Number.isSafeInteger(normalizedTargetGeneration) ||
      normalizedTargetGeneration < 1
    )
      throw new Error("vault_key_generation_invalid");
    return prisma.$transaction(async (tx) => {
      const existing = await tx.vault_device_key_envelopes.findUnique({
        where: {
          userId_targetClientId_keyEpoch: {
            userId: ownerId,
            targetClientId: target,
            keyEpoch: normalizedEpoch,
          },
        },
      });
      if (existing) {
        if (
          existing.sourceClientId === source &&
          existing.envelopeJson === envelopeJson
        )
          return existing;
        throw new Error("vault_key_epoch_conflict");
      }
      const latest = await tx.vault_device_key_envelopes.findFirst({
        where: { userId: ownerId, targetClientId: target },
        orderBy: { keyEpoch: "desc" },
      });
      if (latest && normalizedEpoch <= Number(latest.keyEpoch))
        throw new Error("vault_key_epoch_stale");
      if (tx.vault_device_key_envelopes.count) {
        const recentCount = await tx.vault_device_key_envelopes.count({
          where: {
            userId: ownerId,
            sourceClientId: source,
            createdAt: {
              gte: new Date(Date.now() - ENVELOPE_RATE_WINDOW_MS),
            },
          },
        });
        if (recentCount >= ENVELOPE_RATE_LIMIT)
          throw new Error("vault_key_epoch_rate_limited");
      }
      if (tx.vault_key_epochs) {
        let epoch = await tx.vault_key_epochs.findUnique({
          where: {
            userId_keyEpoch: {
              userId: ownerId,
              keyEpoch: normalizedEpoch,
            },
          },
        });
        if (!epoch) {
          let latestEpoch = await tx.vault_key_epochs.findFirst({
            where: { userId: ownerId },
            orderBy: { keyEpoch: "desc" },
          });
          if (!latestEpoch) {
            const legacyLatest = await tx.vault_device_key_envelopes.findFirst({
              where: { userId: ownerId },
              orderBy: { keyEpoch: "desc" },
            });
            if (legacyLatest) {
              latestEpoch = await tx.vault_key_epochs.create({
                data: {
                  id: vaultId("vkepoch"),
                  userId: ownerId,
                  keyEpoch: legacyLatest.keyEpoch,
                  status: "active",
                  createdByClientId: legacyLatest.sourceClientId,
                  createdAt: legacyLatest.createdAt,
                  activatedAt: legacyLatest.createdAt,
                },
              });
            }
          }
          if (latestEpoch) throw new Error("vault_key_epoch_rotation_required");
          epoch = await tx.vault_key_epochs.create({
            data: {
              id: vaultId("vke"),
              userId: ownerId,
              keyEpoch: normalizedEpoch,
              status: "active",
              createdByClientId: source,
              activatedAt: new Date(),
            },
          });
        }
        if (!["staging", "active"].includes(epoch.status))
          throw new Error("vault_key_epoch_retired");
      }
      try {
        return await tx.vault_device_key_envelopes.create({
          data: {
            id: vaultId("vkenv"),
            userId: ownerId,
            sourceClientId: source,
            targetClientId: target,
            sourceKeyGeneration: normalizedSourceGeneration,
            targetKeyGeneration: normalizedTargetGeneration,
            keyEpoch: normalizedEpoch,
            envelopeJson,
          },
        });
      } catch (error) {
        if (error?.code !== "P2002") throw error;
        const raced = await tx.vault_device_key_envelopes.findUnique({
          where: {
            userId_targetClientId_keyEpoch: {
              userId: ownerId,
              targetClientId: target,
              keyEpoch: normalizedEpoch,
            },
          },
        });
        if (
          raced?.sourceClientId === source &&
          raced?.envelopeJson === envelopeJson
        )
          return raced;
        throw new Error("vault_key_epoch_conflict");
      }
    });
  },

  async pendingDeviceKeyEnvelopes({ userId, targetClientId } = {}) {
    const ownerId = assertUserScope(userId, "vault.pendingDeviceKeyEnvelopes");
    const rows = await prisma.vault_device_key_envelopes.findMany({
      where: {
        userId: ownerId,
        targetClientId: String(targetClientId),
        consumedAt: null,
      },
      orderBy: { keyEpoch: "asc" },
      take: 20,
    });
    return rows.map((row) => ({
      id: row.id,
      sourceClientId: row.sourceClientId,
      targetClientId: row.targetClientId,
      keyEpoch: row.keyEpoch,
      sourceKeyGeneration: row.sourceKeyGeneration || 1,
      targetKeyGeneration: row.targetKeyGeneration || 1,
      envelope: JSON.parse(row.envelopeJson),
      createdAt: row.createdAt,
    }));
  },

  async consumeDeviceKeyEnvelope({ userId, targetClientId, envelopeId } = {}) {
    const ownerId = assertUserScope(userId, "vault.consumeDeviceKeyEnvelope");
    const result = await prisma.vault_device_key_envelopes.updateMany({
      where: {
        id: String(envelopeId),
        userId: ownerId,
        targetClientId: String(targetClientId),
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    });
    return result.count === 1;
  },

  async beginKeyEpochRotation({ userId, clientId } = {}) {
    const ownerId = assertUserScope(userId, "vault.beginKeyEpochRotation");
    const sourceClientId = String(clientId);
    return prisma.$transaction(async (tx) => {
      let latest = await tx.vault_key_epochs.findFirst({
        where: { userId: ownerId },
        orderBy: { keyEpoch: "desc" },
      });
      if (!latest) {
        const legacyLatest = await tx.vault_device_key_envelopes.findFirst({
          where: { userId: ownerId },
          orderBy: { keyEpoch: "desc" },
        });
        if (legacyLatest) {
          latest = await tx.vault_key_epochs.create({
            data: {
              id: vaultId("vkepoch"),
              userId: ownerId,
              keyEpoch: legacyLatest.keyEpoch,
              status: "active",
              createdByClientId: legacyLatest.sourceClientId,
              createdAt: legacyLatest.createdAt,
              activatedAt: legacyLatest.createdAt,
            },
          });
        }
      }
      if (
        latest &&
        Date.now() - new Date(latest.createdAt).getTime() <
          EPOCH_ROTATION_MIN_INTERVAL_MS
      )
        throw new Error("vault_key_epoch_rate_limited");
      if (latest?.status === "staging")
        throw new Error("vault_key_epoch_rotation_in_progress");
      const keyEpoch = Number(latest?.keyEpoch || 0) + 1;
      return tx.vault_key_epochs.create({
        data: {
          id: vaultId("vkepoch"),
          userId: ownerId,
          keyEpoch,
          status: "staging",
          createdByClientId: sourceClientId,
        },
      });
    });
  },

  async listKeyEpochs({ userId } = {}) {
    const ownerId = assertUserScope(userId, "vault.listKeyEpochs");
    return prisma.vault_key_epochs.findMany({
      where: { userId: ownerId },
      orderBy: { keyEpoch: "desc" },
    });
  },

  async cancelKeyEpochRotation({ userId, keyEpoch } = {}) {
    const ownerId = assertUserScope(userId, "vault.cancelKeyEpochRotation");
    const epoch = Number(keyEpoch);
    if (!Number.isSafeInteger(epoch) || epoch < 1)
      throw new Error("vault_key_epoch_invalid");
    const result = await prisma.vault_key_epochs.updateMany({
      where: {
        userId: ownerId,
        keyEpoch: epoch,
        status: "staging",
      },
      data: { status: "cancelled", retirementRequestedAt: new Date() },
    });
    if (result.count !== 1)
      throw new Error("vault_key_epoch_rotation_not_cancellable");
    return { keyEpoch: epoch, status: "cancelled" };
  },

  async getDeviceKeyRegistration({ userId, clientId, keyGeneration } = {}) {
    const ownerId = assertUserScope(userId, "vault.getDeviceKeyRegistration");
    const generation = Number(keyGeneration);
    if (!Number.isSafeInteger(generation) || generation < 1) return null;
    return prisma.vault_device_key_registrations.findUnique({
      where: {
        userId_clientId_keyGeneration: {
          userId: ownerId,
          clientId: String(clientId),
          keyGeneration: generation,
        },
      },
    });
  },

  async listUserRootAuthorizationTargets({
    userId,
    authUserId,
    sourceClientId,
  } = {}) {
    const ownerId = assertUserScope(
      userId,
      "vault.listUserRootAuthorizationTargets"
    );
    const authOwnerId = normalizedAuthUserId(
      authUserId,
      "vault.listUserRootAuthorizationTargets"
    );
    const source = String(sourceClientId || "").trim();
    const activeRoot = await authPrisma.user_root_key_epochs.findFirst({
      where: { authUserId: authOwnerId, status: "active" },
      orderBy: { rootEpoch: "desc" },
    });
    if (!activeRoot) throw new Error("user_root_not_initialized");

    const sourceRegistration =
      await prisma.vault_device_key_registrations.findFirst({
        where: {
          userId: ownerId,
          clientId: source,
          status: "active",
          revokedAt: null,
        },
        orderBy: { keyGeneration: "desc" },
      });
    if (!sourceRegistration)
      throw new Error("user_root_source_registration_unavailable");
    const sourceAuthorization =
      await authPrisma.user_root_key_envelopes.findFirst({
        where: {
          authUserId: authOwnerId,
          targetClientId: source,
          targetKeyGeneration: sourceRegistration.keyGeneration,
          rootEpoch: activeRoot.rootEpoch,
          rootKeyId: activeRoot.rootKeyId,
          consumedAt: { not: null },
        },
        select: { id: true },
      });
    if (!sourceAuthorization)
      throw new Error("user_root_source_device_not_authorized");

    const registrations = await prisma.vault_device_key_registrations.findMany({
      where: {
        userId: ownerId,
        clientId: { not: source },
        status: "active",
        revokedAt: null,
      },
      orderBy: [{ clientId: "asc" }, { keyGeneration: "desc" }],
    });
    const latestByClient = new Map();
    for (const registration of registrations) {
      if (!latestByClient.has(registration.clientId))
        latestByClient.set(registration.clientId, registration);
    }
    const latest = [...latestByClient.values()];
    if (!latest.length) return [];

    const existing = await authPrisma.user_root_key_envelopes.findMany({
      where: {
        authUserId: authOwnerId,
        rootEpoch: activeRoot.rootEpoch,
        rootKeyId: activeRoot.rootKeyId,
        targetClientId: { in: latest.map((entry) => entry.clientId) },
      },
      select: {
        targetClientId: true,
        targetKeyGeneration: true,
      },
    });
    const covered = new Set(
      existing.map(
        (entry) => `${entry.targetClientId}:${entry.targetKeyGeneration}`
      )
    );
    return latest.filter(
      (entry) => !covered.has(`${entry.clientId}:${entry.keyGeneration}`)
    );
  },

  async acknowledgeKeyEpoch({
    userId,
    clientId,
    keyEpoch,
    keyGeneration,
    inventoryHash = null,
  } = {}) {
    const ownerId = assertUserScope(userId, "vault.acknowledgeKeyEpoch");
    const epoch = Number(keyEpoch);
    const generation = Number(keyGeneration);
    if (!Number.isSafeInteger(epoch) || epoch < 1)
      throw new Error("vault_key_epoch_invalid");
    if (!Number.isSafeInteger(generation) || generation < 1)
      throw new Error("vault_key_generation_invalid");
    const normalizedHash = inventoryHash
      ? String(inventoryHash).toLowerCase()
      : null;
    if (normalizedHash && !/^[a-f0-9]{64}$/.test(normalizedHash))
      throw new Error("vault_inventory_hash_invalid");
    return prisma.$transaction(async (tx) => {
      const targetEpoch = await tx.vault_key_epochs.findUnique({
        where: {
          userId_keyEpoch: { userId: ownerId, keyEpoch: epoch },
        },
      });
      if (!targetEpoch || targetEpoch.status === "retired")
        throw new Error("vault_key_epoch_unavailable");
      const client = await tx.athena_clients.findFirst({
        where: {
          userId: ownerId,
          clientId: String(clientId),
          revokedAt: null,
          vaultKeyGeneration: generation,
        },
      });
      if (!client) throw new Error("vault_device_key_generation_untrusted");
      const acknowledgement = await tx.vault_epoch_acknowledgements.upsert({
        where: {
          userId_clientId_keyEpoch: {
            userId: ownerId,
            clientId: String(clientId),
            keyEpoch: epoch,
          },
        },
        create: {
          id: vaultId("vkack"),
          userId: ownerId,
          clientId: String(clientId),
          keyEpoch: epoch,
          keyGeneration: generation,
          inventoryHash: normalizedHash,
        },
        update: {
          keyGeneration: generation,
          inventoryHash: normalizedHash,
          acknowledgedAt: new Date(),
        },
      });
      const activeDeviceRows = await tx.athena_clients.findMany({
        where: {
          userId: ownerId,
          revokedAt: null,
          vaultKeyGeneration: { gt: 0 },
        },
        select: { clientId: true },
      });
      const activeDeviceIds = activeDeviceRows.map((entry) => entry.clientId);
      const acknowledgements =
        activeDeviceIds.length === 0
          ? 0
          : await tx.vault_epoch_acknowledgements.count({
              where: {
                userId: ownerId,
                keyEpoch: epoch,
                clientId: { in: activeDeviceIds },
              },
            });
      const activeDevices = activeDeviceIds.length;
      if (
        targetEpoch.status === "staging" &&
        activeDevices > 0 &&
        acknowledgements >= activeDevices
      ) {
        await tx.vault_key_epochs.updateMany({
          where: {
            userId: ownerId,
            status: "active",
            keyEpoch: { lt: epoch },
          },
          data: { status: "retiring", retirementRequestedAt: new Date() },
        });
        await tx.vault_key_epochs.update({
          where: { id: targetEpoch.id },
          data: { status: "active", activatedAt: new Date() },
        });
      }
      return { acknowledgement, activeDevices, acknowledgements };
    });
  },

  async retireKeyEpoch({ userId, keyEpoch } = {}) {
    const ownerId = assertUserScope(userId, "vault.retireKeyEpoch");
    const epoch = Number(keyEpoch);
    if (!Number.isSafeInteger(epoch) || epoch < 1)
      throw new Error("vault_key_epoch_invalid");
    return prisma.$transaction(async (tx) => {
      const current = await tx.vault_key_epochs.findUnique({
        where: { userId_keyEpoch: { userId: ownerId, keyEpoch: epoch } },
      });
      if (!current || current.status === "retired")
        throw new Error("vault_key_epoch_unavailable");
      const newer = await tx.vault_key_epochs.findFirst({
        where: {
          userId: ownerId,
          keyEpoch: { gt: epoch },
          status: "active",
        },
        orderBy: { keyEpoch: "desc" },
      });
      if (!newer) throw new Error("vault_newer_active_epoch_required");
      const [activeDeviceRows, recoveryPackage] = await Promise.all([
        tx.athena_clients.findMany({
          where: {
            userId: ownerId,
            revokedAt: null,
            vaultKeyGeneration: { gt: 0 },
          },
          select: { clientId: true },
        }),
        tx.vault_recovery_packages.findFirst({
          where: {
            userId: ownerId,
            keyEpoch: { gte: newer.keyEpoch },
            status: "ready",
            revokedAt: null,
          },
        }),
      ]);
      const activeDeviceIds = activeDeviceRows.map((entry) => entry.clientId);
      const activeDevices = activeDeviceIds.length;
      const acknowledgements =
        activeDevices === 0
          ? 0
          : await tx.vault_epoch_acknowledgements.count({
              where: {
                userId: ownerId,
                keyEpoch: newer.keyEpoch,
                clientId: { in: activeDeviceIds },
              },
            });
      if (activeDevices < 1 || acknowledgements < activeDevices)
        throw new Error("vault_epoch_acknowledgements_incomplete");
      if (!recoveryPackage) throw new Error("vault_recovery_package_required");
      return tx.vault_key_epochs.update({
        where: { id: current.id },
        data: { status: "retired", retiredAt: new Date() },
      });
    });
  },

  async storeRecoveryPackage({
    userId,
    clientId,
    recoveryKeyId,
    keyEpoch,
    suiteId,
    encryptedPackage,
  } = {}) {
    const ownerId = assertUserScope(userId, "vault.storeRecoveryPackage");
    const normalizedKeyId = String(recoveryKeyId || "").trim();
    const epoch = Number(keyEpoch);
    const encryptedPackageJson = JSON.stringify(encryptedPackage || {});
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(normalizedKeyId))
      throw new Error("vault_recovery_key_id_invalid");
    if (!Number.isSafeInteger(epoch) || epoch < 1)
      throw new Error("vault_key_epoch_invalid");
    if (String(suiteId) !== "vault-xwing-mldsa65-v1")
      throw new Error("vault_recovery_suite_invalid");
    if (
      encryptedPackageJson.length < 32 ||
      encryptedPackageJson.length > 256 * 1024
    )
      throw new Error("vault_recovery_package_size_invalid");
    if (
      encryptedPackage?.version !== "athena-vault-recovery-package:v1" ||
      encryptedPackage?.recoveryKeyId !== normalizedKeyId ||
      Number(encryptedPackage?.highestKeyEpoch) !== epoch ||
      !/^[A-Za-z0-9_-]{43}$/.test(String(encryptedPackage?.salt || "")) ||
      !/^[A-Za-z0-9_-]{32,349526}$/.test(
        String(encryptedPackage?.sealedEpochMaterials || "")
      )
    )
      throw new Error("vault_recovery_package_invalid");
    return prisma.vault_recovery_packages.upsert({
      where: {
        userId_recoveryKeyId: {
          userId: ownerId,
          recoveryKeyId: normalizedKeyId,
        },
      },
      create: {
        id: vaultId("vkr"),
        userId: ownerId,
        recoveryKeyId: normalizedKeyId,
        keyEpoch: epoch,
        suiteId: String(suiteId),
        encryptedPackageJson,
        createdByClientId: String(clientId),
      },
      update: {
        keyEpoch: epoch,
        suiteId: String(suiteId),
        encryptedPackageJson,
        status: "ready",
        createdByClientId: String(clientId),
        revokedAt: null,
      },
    });
  },

  async getRecoveryPackage({ userId, recoveryKeyId } = {}) {
    const ownerId = assertUserScope(userId, "vault.getRecoveryPackage");
    const row = await prisma.vault_recovery_packages.findFirst({
      where: {
        userId: ownerId,
        recoveryKeyId: String(recoveryKeyId),
        status: "ready",
        revokedAt: null,
      },
    });
    if (!row) return null;
    await prisma.vault_recovery_packages.update({
      where: { id: row.id },
      data: { lastRecoveredAt: new Date() },
    });
    return {
      id: row.id,
      recoveryKeyId: row.recoveryKeyId,
      keyEpoch: row.keyEpoch,
      suiteId: row.suiteId,
      encryptedPackage: JSON.parse(row.encryptedPackageJson),
      createdAt: row.createdAt,
    };
  },

  async revokeRecoveryPackage({ userId, recoveryKeyId } = {}) {
    const ownerId = assertUserScope(userId, "vault.revokeRecoveryPackage");
    return prisma.vault_recovery_packages.updateMany({
      where: {
        userId: ownerId,
        recoveryKeyId: String(recoveryKeyId),
        revokedAt: null,
      },
      data: { status: "revoked", revokedAt: new Date() },
    });
  },
};

module.exports = {
  VaultRepository,
  vaultItemEnvelope,
  encryptedPayloadEnvelope,
};
