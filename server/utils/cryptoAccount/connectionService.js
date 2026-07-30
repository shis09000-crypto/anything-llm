const crypto = require("crypto");
const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const CryptoData = lazyDataAccessFacade("crypto");
const {
  unwrapMaterial,
  wrapMaterial,
} = require("../security/keyCustody/remoteClient");
const { queueUserDomainWrap } = require("../security/userDomainWrapService");
const {
  USER_DOMAIN_KEY_VERSION,
  USER_DOMAIN_WRAP_VERSION,
} = require("../security/userDomainWrapping");
const {
  openJsonEnvelope,
  sealJsonEnvelope,
} = require("../security/keyCustody/aeadEnvelope");

const CONNECTION_PROVIDER = "gate";
const CONNECTION_ENVELOPE_VERSION = "athena-crypto-account-credentials:v1";
const CONNECTION_ALGORITHM = "aes-256-gcm";
const ACTIVE_WRAP_STATUSES = new Set(["active", "active_device_verified"]);
const ACTIVE_CONNECTION_STATUS = "active";

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function cryptoAccountError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeEnvironment(value = "production") {
  const normalized = String(value || "production")
    .trim()
    .toLowerCase();
  if (!["production", "testnet"].includes(normalized)) {
    throw cryptoAccountError("crypto_account_environment_invalid");
  }
  return normalized;
}

function normalizeOwner(user = null) {
  const userId = Number(user?.id);
  const authUserId = Number(user?.authUserId);
  if (
    !Number.isSafeInteger(userId) ||
    userId < 1 ||
    !Number.isSafeInteger(authUserId) ||
    authUserId < 1
  ) {
    throw cryptoAccountError("crypto_account_owner_invalid");
  }
  return { userId, authUserId };
}

function credentialsAad({
  userId,
  authUserId,
  connectionId,
  provider,
  environment,
  credentialVersion,
}) {
  return Buffer.from(
    canonicalJson({
      version: CONNECTION_ENVELOPE_VERSION,
      userId: Number(userId),
      authUserId: Number(authUserId),
      connectionId: String(connectionId),
      provider: String(provider),
      environment: normalizeEnvironment(environment),
      credentialVersion: Number(credentialVersion),
    }),
    "utf8"
  );
}

function sealCredentials({
  credentials,
  dek,
  userId,
  authUserId,
  connectionId,
  provider = CONNECTION_PROVIDER,
  environment,
  credentialVersion,
}) {
  const key = Buffer.from(dek);
  if (key.length !== 32) throw cryptoAccountError("crypto_account_dek_invalid");
  const aad = credentialsAad({
    userId,
    authUserId,
    connectionId,
    provider,
    environment,
    credentialVersion,
  });
  return JSON.stringify(
    sealJsonEnvelope({
      key,
      aad,
      version: CONNECTION_ENVELOPE_VERSION,
      algorithm: CONNECTION_ALGORITHM,
      payload: {
        apiKey: String(credentials.apiKey),
        apiSecret: String(credentials.apiSecret),
        environment: normalizeEnvironment(environment),
        readOnly: true,
      },
    })
  );
}

function openCredentials(row, dek) {
  let envelope;
  try {
    envelope = JSON.parse(row.encryptedCredentials);
  } catch {
    throw cryptoAccountError("crypto_account_credentials_invalid");
  }
  if (
    envelope?.version !== CONNECTION_ENVELOPE_VERSION ||
    envelope?.algorithm !== CONNECTION_ALGORITHM
  ) {
    throw cryptoAccountError("crypto_account_credentials_invalid");
  }
  const key = Buffer.from(dek);
  if (key.length !== 32) throw cryptoAccountError("crypto_account_dek_invalid");
  try {
    const payload = openJsonEnvelope({
      key,
      aad: credentialsAad({
        userId: row.userId,
        authUserId: row.authUserId,
        connectionId: row.id,
        provider: row.provider,
        environment: row.environment,
        credentialVersion: row.credentialVersion,
      }),
      envelope,
      version: CONNECTION_ENVELOPE_VERSION,
      algorithm: CONNECTION_ALGORITHM,
    });
    if (
      !payload.apiKey ||
      !payload.apiSecret ||
      payload.readOnly !== true ||
      normalizeEnvironment(payload.environment) !== row.environment
    ) {
      throw cryptoAccountError("crypto_account_credentials_invalid");
    }
    return payload;
  } catch (error) {
    if (error?.code) throw error;
    throw cryptoAccountError("crypto_account_credentials_invalid");
  }
}

function credentialFingerprint(apiKey, apiSecret) {
  return crypto
    .createHash("sha256")
    .update(`${String(apiKey)}\u0000${String(apiSecret)}`)
    .digest("hex")
    .slice(0, 16);
}

async function activeRoot(authUserId) {
  return CryptoData.activeUserRoot({ authUserId });
}

async function activeConnectionForUser(
  user,
  { provider = CONNECTION_PROVIDER, environment = "production" } = {}
) {
  const owner = normalizeOwner(user);
  return CryptoData.findAccountConnection({
    where: {
      ...owner,
      provider: String(provider),
      environment: normalizeEnvironment(environment),
      status: ACTIVE_CONNECTION_STATUS,
      readOnly: true,
      revokedAt: null,
    },
    orderBy: { updatedAt: "desc" },
  });
}

async function currentAgentWrap(connection, root = null) {
  const active = root || (await activeRoot(connection.authUserId));
  if (!active) return null;
  return CryptoData.findUserDomainWrap({
    where: {
      userId: connection.userId,
      authUserId: connection.authUserId,
      resourceType: "direct-field-dek",
      resourceId: connection.id,
      domain: "agent",
      rootKeyId: active.rootKeyId,
      rootEpoch: active.rootEpoch,
      domainKeyVersion: connection.domainKeyVersion,
      status: { in: [...ACTIVE_WRAP_STATUSES] },
    },
    orderBy: { completedAt: "desc" },
  });
}

async function cryptoAccountEligibility(user) {
  let owner;
  try {
    owner = normalizeOwner(user);
  } catch {
    return {
      registered: true,
      available: false,
      approvalRequired: true,
      schedulable: false,
      reason: "owner_unavailable",
    };
  }
  const root = await activeRoot(owner.authUserId);
  if (!root) {
    return {
      registered: true,
      available: false,
      approvalRequired: true,
      schedulable: false,
      reason: "user_root_not_initialized",
    };
  }
  const connection = await CryptoData.findAccountConnection({
    where: {
      ...owner,
      provider: CONNECTION_PROVIDER,
      status: ACTIVE_CONNECTION_STATUS,
      readOnly: true,
      revokedAt: null,
    },
    orderBy: { updatedAt: "desc" },
  });
  if (!connection) {
    return {
      registered: true,
      available: false,
      approvalRequired: true,
      schedulable: false,
      reason: "crypto_account_not_bound",
    };
  }
  if (
    connection.rootKeyId !== root.rootKeyId ||
    Number(connection.rootEpoch) !== Number(root.rootEpoch)
  ) {
    return {
      registered: true,
      available: false,
      approvalRequired: true,
      schedulable: false,
      reason: "crypto_account_root_wrap_stale",
    };
  }
  const wrap = await currentAgentWrap(connection, root);
  if (!wrap) {
    return {
      registered: true,
      available: false,
      approvalRequired: true,
      schedulable: false,
      reason: "crypto_account_agent_wrap_pending",
    };
  }
  return {
    registered: true,
    available: true,
    approvalRequired: true,
    schedulable: true,
    provider: connection.provider,
    environment: connection.environment,
    credentialVersion: connection.credentialVersion,
    rootKeyId: connection.rootKeyId,
    domainKeyVersion: connection.domainKeyVersion,
    reason: null,
  };
}

async function createOrRotateConnection({
  user,
  apiKey,
  apiSecret,
  environment = "production",
  provider = CONNECTION_PROVIDER,
} = {}) {
  const owner = normalizeOwner(user);
  if (String(provider) !== CONNECTION_PROVIDER)
    throw cryptoAccountError("crypto_account_provider_unsupported");
  if (!apiKey || !apiSecret)
    throw cryptoAccountError("crypto_account_credentials_missing");
  const root = await activeRoot(owner.authUserId);
  if (!root) throw cryptoAccountError("user_root_not_initialized");
  const env = normalizeEnvironment(environment);
  const existing = await CryptoData.uniqueAccountConnection({
    where: {
      authUserId_provider_environment: {
        authUserId: owner.authUserId,
        provider: CONNECTION_PROVIDER,
        environment: env,
      },
    },
  });
  const connectionId = existing?.id || `crypto_conn_${crypto.randomUUID()}`;
  const credentialVersion = Number(existing?.credentialVersion || 0) + 1;
  const domainKeyVersion = existing
    ? Number(existing.domainKeyVersion || 0) + 1
    : USER_DOMAIN_KEY_VERSION;
  const dek = crypto.randomBytes(32);
  try {
    const encryptedCredentials = sealCredentials({
      credentials: { apiKey, apiSecret },
      dek,
      ...owner,
      connectionId,
      provider: CONNECTION_PROVIDER,
      environment: env,
      credentialVersion,
    });
    const platformWrappedDek = await wrapMaterial(dek.toString("base64url"), {
      purpose: "crypto-account-dek",
      domain: "crypto-account",
      resource: connectionId,
      operation: "wrap-crypto-account-dek",
    });
    const row = await CryptoData.upsertAccountConnection({
      where: {
        authUserId_provider_environment: {
          authUserId: owner.authUserId,
          provider: CONNECTION_PROVIDER,
          environment: env,
        },
      },
      create: {
        id: connectionId,
        ...owner,
        provider: CONNECTION_PROVIDER,
        environment: env,
        status: "pending_wrap",
        readOnly: true,
        encryptedCredentials,
        platformWrappedDek,
        wrapVersion: USER_DOMAIN_WRAP_VERSION,
        rootKeyId: root.rootKeyId,
        rootEpoch: root.rootEpoch,
        domainKeyVersion,
        credentialVersion,
        rotationState: existing ? "rotating" : "stable",
        credentialFingerprint: credentialFingerprint(apiKey, apiSecret),
      },
      update: {
        userId: owner.userId,
        encryptedCredentials,
        platformWrappedDek,
        status: "pending_wrap",
        readOnly: true,
        wrapVersion: USER_DOMAIN_WRAP_VERSION,
        rootKeyId: root.rootKeyId,
        rootEpoch: root.rootEpoch,
        domainKeyVersion,
        credentialVersion,
        rotationState: "rotating",
        credentialFingerprint: credentialFingerprint(apiKey, apiSecret),
        revokedAt: null,
        updatedAt: new Date(),
      },
    });
    const queued = await queueUserDomainWrap({
      ...owner,
      resourceType: "direct-field-dek",
      resourceId: connectionId,
      domain: "agent",
      platformWrappedValue: platformWrappedDek,
      domainKeyVersion,
    });
    if (!queued.queued)
      throw cryptoAccountError(
        queued.reason || "crypto_account_wrap_queue_failed"
      );
    if (existing) {
      require("./accountHub").accountCryptoHubRegistry.invalidateConnection(
        existing.id
      );
    }
    return {
      connection: {
        id: row.id,
        provider: row.provider,
        environment: row.environment,
        status: row.status,
        readOnly: row.readOnly,
        credentialVersion: row.credentialVersion,
        credentialFingerprint: row.credentialFingerprint,
        rootKeyId: row.rootKeyId,
        domainKeyVersion: row.domainKeyVersion,
      },
      wrap: queued.wrap,
    };
  } finally {
    dek.fill(0);
  }
}

async function activateConnectionAfterWrap({
  userId,
  authUserId,
  connectionId,
} = {}) {
  const connection = await CryptoData.findAccountConnection({
    where: {
      id: String(connectionId),
      userId: Number(userId),
      authUserId: Number(authUserId),
      readOnly: true,
      revokedAt: null,
    },
  });
  if (!connection)
    throw cryptoAccountError("crypto_account_connection_not_found");
  const wrap = await currentAgentWrap(connection);
  if (!wrap) throw cryptoAccountError("crypto_account_agent_wrap_pending");
  return CryptoData.updateAccountConnection({
    where: { id: connection.id },
    data: {
      status: ACTIVE_CONNECTION_STATUS,
      rotationState: "stable",
      updatedAt: new Date(),
    },
  });
}

async function platformDekMaterial(connectionId, userId) {
  const row = await CryptoData.findAccountConnection({
    where: {
      id: String(connectionId),
      userId: Number(userId),
      readOnly: true,
      revokedAt: null,
    },
    select: { platformWrappedDek: true },
  });
  if (!row?.platformWrappedDek)
    throw cryptoAccountError("user_domain_resource_not_found");
  const material = Buffer.from(
    await unwrapMaterial(row.platformWrappedDek, {
      purpose: "crypto-account-dek",
      domain: "crypto-account",
      resource: String(connectionId),
      operation: "unwrap-crypto-account-dek",
    }),
    "base64url"
  );
  if (material.length !== 32) {
    material.fill(0);
    throw cryptoAccountError("crypto_account_dek_invalid");
  }
  return material;
}

async function resolveApprovedConnection({
  user,
  expectedCredentialVersion = null,
  expectedRootKeyId = null,
  expectedDomainKeyVersion = null,
} = {}) {
  const eligibility = await cryptoAccountEligibility(user);
  if (!eligibility.available)
    throw cryptoAccountError(
      eligibility.reason || "crypto_account_unavailable"
    );
  const connection = await activeConnectionForUser(user, {
    environment: eligibility.environment || "production",
  });
  if (!connection)
    throw cryptoAccountError("crypto_account_connection_not_found");
  if (
    expectedCredentialVersion !== null &&
    Number(expectedCredentialVersion) !== Number(connection.credentialVersion)
  ) {
    throw cryptoAccountError("crypto_account_credential_version_changed");
  }
  if (expectedRootKeyId && String(expectedRootKeyId) !== connection.rootKeyId) {
    throw cryptoAccountError("crypto_account_root_changed");
  }
  if (
    expectedDomainKeyVersion !== null &&
    Number(expectedDomainKeyVersion) !== Number(connection.domainKeyVersion)
  ) {
    throw cryptoAccountError("crypto_account_domain_key_changed");
  }
  const dek = Buffer.from(
    await unwrapMaterial(connection.platformWrappedDek, {
      purpose: "crypto-account-dek",
      domain: "crypto-account",
      resource: connection.id,
      operation: "resolve-crypto-account-dek",
    }),
    "base64url"
  );
  try {
    const credentials = openCredentials(connection, dek);
    return {
      connection,
      credentials: {
        apiKey: credentials.apiKey,
        apiSecret: credentials.apiSecret,
        env: credentials.environment,
      },
    };
  } finally {
    dek.fill(0);
  }
}

async function revokeConnection({ user, provider = CONNECTION_PROVIDER } = {}) {
  const owner = normalizeOwner(user);
  const rows = await CryptoData.listAccountConnections({
    where: { ...owner, provider: String(provider), revokedAt: null },
    select: { id: true },
  });
  await CryptoData.updateAccountConnections({
    where: { ...owner, provider: String(provider), revokedAt: null },
    data: {
      status: "revoked",
      rotationState: "revoked",
      revokedAt: new Date(),
      updatedAt: new Date(),
    },
  });
  const registry = require("./accountHub").accountCryptoHubRegistry;
  for (const row of rows) registry.invalidateConnection(row.id);
  return rows.map((row) => row.id);
}

module.exports = {
  ACTIVE_CONNECTION_STATUS,
  CONNECTION_ENVELOPE_VERSION,
  CONNECTION_PROVIDER,
  activateConnectionAfterWrap,
  activeConnectionForUser,
  createOrRotateConnection,
  credentialFingerprint,
  cryptoAccountEligibility,
  normalizeOwner,
  openCredentials,
  platformDekMaterial,
  resolveApprovedConnection,
  revokeConnection,
  sealCredentials,
};
