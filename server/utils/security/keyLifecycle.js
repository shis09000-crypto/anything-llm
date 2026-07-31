const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DataAccessCenter } = require("../dataAccess");
const { storagePath } = require("../environment");
const {
  activateKey,
  clearRuntimeActiveKey,
  generatePendingKey,
  health: custodyHealth,
  keyProvider,
  resolveActiveKey,
  resolveKey,
  setRuntimeActiveKey,
} = require("./keyCustody");
const { SERVER_DATA_PURPOSE } = require("./keyCustody/providers");
const {
  securityState,
  setBootstrapPromise,
  setSecurityState,
} = require("./keyRuntimeState");

const CANARY_VERSION = "athena-key-canary:v1";
const CANARY_TEXT = "athena-key-custody-canary";
const DEFAULT_DOMAINS = [
  "database-secrets",
  "shared-auth-secrets",
  "chat-key-wraps",
  "document-store",
  "vector-cache",
];
const DEFAULT_ROTATION_APPROVAL_TTL_MS = 30 * 60 * 1000;

function keyDualControlRequired(env = process.env) {
  const environment = String(env.APP_ENV || env.NODE_ENV || "development")
    .trim()
    .toLowerCase();
  if (environment === "production") return true;
  return env.ATHENA_KEY_DUAL_CONTROL_REQUIRED === "true";
}

function rotationApprovalPolicy({ createdBy = null, env = process.env } = {}) {
  const required = keyDualControlRequired(env);
  const actor = Number(createdBy);
  if (required && (!Number.isSafeInteger(actor) || actor < 1)) {
    throw new Error("key_rotation_authenticated_initiator_required");
  }
  const ttlMs = Math.max(
    5 * 60 * 1000,
    Math.min(
      Number(env.ATHENA_KEY_ROTATION_APPROVAL_TTL_MS) ||
        DEFAULT_ROTATION_APPROVAL_TTL_MS,
      24 * 60 * 60 * 1000
    )
  );
  return {
    requiredApprovals: required ? 1 : 0,
    approvalExpiresAt: required ? new Date(Date.now() + ttlMs) : null,
  };
}

function rotationExecutionAuthorization({
  job,
  approvals = [],
  actorUserId = null,
  now = new Date(),
} = {}) {
  const required = Number(job?.requiredApprovals || 0);
  if (required < 1) return { authorized: true, approvalCount: 0 };
  const actor = Number(actorUserId);
  if (!Number.isSafeInteger(actor) || actor < 1)
    return { authorized: false, reason: "key_rotation_executor_required" };
  if (
    !job.approvalExpiresAt ||
    Date.parse(job.approvalExpiresAt) <= now.getTime()
  )
    return { authorized: false, reason: "key_rotation_approval_expired" };
  const distinctApprovers = new Set(
    approvals
      .filter(
        (entry) =>
          entry.decision === "approved" &&
          Date.parse(entry.expiresAt) > now.getTime() &&
          Number(entry.approverUserId) !== Number(job.createdBy)
      )
      .map((entry) => Number(entry.approverUserId))
      .filter((entry) => Number.isSafeInteger(entry) && entry > 0)
  );
  if (distinctApprovers.size < required)
    return {
      authorized: false,
      reason: "key_rotation_independent_approval_required",
      approvalCount: distinctApprovers.size,
    };
  return { authorized: true, approvalCount: distinctApprovers.size };
}

function aadForV2(keyId, purpose) {
  return Buffer.from(
    JSON.stringify({ version: "enc:v2", keyId, purpose }),
    "utf8"
  );
}

function decryptEnvelopeWithCustody(value) {
  if (typeof value !== "string" || !value.startsWith("enc:")) return value;
  const parts = value.split(":");
  let descriptor;
  let iv;
  let authTag;
  let ciphertext;
  let aad = null;

  if (parts[1] === "v1" && parts.length === 5) {
    descriptor = resolveActiveKey();
    [, , iv, authTag, ciphertext] = parts;
  } else if (parts[1] === "v2" && parts.length === 7) {
    const [, , keyId, encodedPurpose, nextIv, nextTag, nextCiphertext] = parts;
    const purpose = Buffer.from(encodedPurpose, "base64url").toString("utf8");
    // The envelope purpose is domain AAD, while the custody purpose remains
    // the server-data-at-rest key family.
    descriptor = resolveKey(keyId);
    if (!descriptor) throw new Error("encrypted_key_not_available");
    iv = nextIv;
    authTag = nextTag;
    ciphertext = nextCiphertext;
    aad = aadForV2(keyId, purpose);
  } else {
    throw new Error("unsupported_encrypted_secret_format");
  }

  if (!descriptor?.material) throw new Error("active_encryption_key_missing");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    descriptor.material,
    Buffer.from(iv, "base64url")
  );
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(authTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function createCanary(descriptor) {
  const iv = crypto.randomBytes(12);
  const aad = Buffer.from(`${CANARY_VERSION}:${descriptor.keyId}`, "utf8");
  const cipher = crypto.createCipheriv("aes-256-gcm", descriptor.material, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(CANARY_TEXT, "utf8"),
    cipher.final(),
  ]);
  return JSON.stringify({
    version: CANARY_VERSION,
    keyId: descriptor.keyId,
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  });
}

function verifyCanary(envelope, descriptor) {
  const parsed = JSON.parse(envelope || "{}");
  if (parsed.version !== CANARY_VERSION || parsed.keyId !== descriptor.keyId) {
    throw new Error("key_canary_identity_mismatch");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    descriptor.material,
    Buffer.from(parsed.iv, "base64url")
  );
  decipher.setAAD(Buffer.from(`${CANARY_VERSION}:${descriptor.keyId}`, "utf8"));
  decipher.setAuthTag(Buffer.from(parsed.authTag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  if (plaintext !== CANARY_TEXT) throw new Error("key_canary_decrypt_failed");
  return true;
}

async function querySample(sql, database = "main") {
  try {
    const rows = await (database === "auth"
      ? DataAccessCenter.securityKey.probeAuthSample({ sql })
      : DataAccessCenter.securityKey.probeSample({ sql }));
    return rows?.[0]?.value ?? null;
  } catch {
    return null;
  }
}

function firstJsonFiles(root, limit = 24) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (files.length >= limit) return;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.name.endsWith(".json")) files.push(target);
    }
  };
  visit(root);
  return files;
}

function encryptedPayloadFromFile(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (typeof parsed?.encryptedPayload === "string")
      return parsed.encryptedPayload;
    if (typeof parsed?.payload?.encryptedPayload === "string") {
      return parsed.payload.encryptedPayload;
    }
  } catch {}
  return null;
}

async function encryptedDataExists() {
  const database = await querySample(`
    SELECT "value" AS value FROM "system_settings" WHERE "value" LIKE 'enc:%' LIMIT 1
  `);
  if (database) return true;
  const sharedAuth = await querySample(
    `SELECT "value" AS value FROM "system_settings" WHERE "value" LIKE 'enc:%' LIMIT 1`,
    "auth"
  );
  if (sharedAuth) return true;
  const chat = await querySample(`
    SELECT "wrapped_key" AS value FROM "workspace_chat_conversation_keys" WHERE "wrapped_key" LIKE 'enc:%' LIMIT 1
  `);
  if (chat) return true;
  for (const root of [storagePath("documents"), storagePath("vector-cache")]) {
    if (
      firstJsonFiles(root, 8).some((file) => encryptedPayloadFromFile(file))
    ) {
      return true;
    }
  }
  return false;
}

async function probeDatabaseSecret() {
  const candidates = [
    `SELECT "value" AS value FROM "system_settings" WHERE "value" LIKE 'enc:%' LIMIT 1`,
    `SELECT "encryptedPayload" AS value FROM "user_memory_blocks" WHERE "encryptedPayload" LIKE 'enc:%' LIMIT 1`,
    `SELECT "signingSecretEncrypted" AS value FROM "athena_clients" WHERE "signingSecretEncrypted" LIKE 'enc:%' LIMIT 1`,
  ];
  for (const query of candidates) {
    const value = await querySample(query);
    if (!value) continue;
    decryptEnvelopeWithCustody(value);
    return { state: "verified", sample: true };
  }
  return { state: "empty", sample: false };
}

async function probeSharedAuthSecret() {
  const value = await querySample(
    `SELECT "value" AS value FROM "system_settings" WHERE "value" LIKE 'enc:%' LIMIT 1`,
    "auth"
  );
  if (!value) return { state: "empty", sample: false };
  decryptEnvelopeWithCustody(value);
  return { state: "verified", sample: true };
}

async function probeChatKeyWrap() {
  const value = await querySample(`
    SELECT "wrapped_key" AS value FROM "workspace_chat_conversation_keys"
    WHERE "wrapped_key" LIKE 'enc:%' LIMIT 1
  `);
  if (!value) return { state: "empty", sample: false };
  const decoded = decryptEnvelopeWithCustody(value);
  if (!decoded || Buffer.from(decoded, "base64url").length !== 32) {
    throw new Error("chat_wrapped_key_invalid");
  }
  return { state: "verified", sample: true };
}

function probeFileDomain(name, root) {
  const files = firstJsonFiles(root);
  for (const file of files) {
    const payload = encryptedPayloadFromFile(file);
    if (!payload) continue;
    const decoded = decryptEnvelopeWithCustody(payload);
    JSON.parse(decoded);
    return {
      domain: name,
      state: "verified",
      sample: true,
      filesSeen: files.length,
    };
  }
  return {
    domain: name,
    state: "empty",
    sample: false,
    filesSeen: files.length,
  };
}

async function probeDomains() {
  const results = [];
  for (const [domain, probe] of [
    ["database-secrets", probeDatabaseSecret],
    ["shared-auth-secrets", probeSharedAuthSecret],
    ["chat-key-wraps", probeChatKeyWrap],
  ]) {
    try {
      results.push({ domain, ...(await probe()) });
    } catch (error) {
      results.push({
        domain,
        state: "failed",
        sample: true,
        error: error.message,
      });
    }
  }
  for (const [domain, root] of [
    ["document-store", storagePath("documents")],
    ["vector-cache", storagePath("vector-cache")],
  ]) {
    try {
      results.push(probeFileDomain(domain, root));
    } catch (error) {
      results.push({
        domain,
        state: "failed",
        sample: true,
        error: error.message,
      });
    }
  }
  return results;
}

async function appendEvent(event, descriptor, metadata = {}, createdBy = null) {
  try {
    return await DataAccessCenter.securityKey.appendEvent({
      event,
      keyId: descriptor?.keyId || null,
      purpose: descriptor?.purpose || SERVER_DATA_PURPOSE,
      metadata,
      createdBy,
    });
  } catch {
    return null;
  }
}

async function ensureRegistry(descriptor) {
  let active = await DataAccessCenter.securityKey.activeRegistry({
    purpose: SERVER_DATA_PURPOSE,
  });
  if (active && active.keyId !== descriptor.keyId) {
    throw new Error("key_registry_active_mismatch");
  }

  if (!active) {
    const existing = await DataAccessCenter.securityKey.registryByKeyId({
      keyId: descriptor.keyId,
    });
    if (existing) {
      active = await DataAccessCenter.securityKey.updateRegistry({
        keyId: descriptor.keyId,
        updates: { status: "active", activatedAt: new Date() },
      });
    } else {
      const versions = await DataAccessCenter.securityKey.listRegistry({
        purpose: SERVER_DATA_PURPOSE,
      });
      active = await DataAccessCenter.securityKey.createRegistry({
        keyId: descriptor.keyId,
        purpose: SERVER_DATA_PURPOSE,
        providerType: descriptor.providerType,
        ...keyRegistryCryptoMetadata(descriptor),
        fingerprint: descriptor.fingerprint,
        version:
          Math.max(0, ...versions.map((item) => Number(item.version) || 0)) + 1,
        status: "active",
        canaryEnvelope: createCanary(descriptor),
        sourceDescriptor: custodyHealth().source || descriptor.providerType,
        metadata: { importedFromLegacyV1: true },
        activatedAt: new Date(),
      });
      await appendEvent("key_registered", descriptor, {
        providerType: descriptor.providerType,
        source: custodyHealth().source,
      });
    }
  }

  if (!active.canaryEnvelope) {
    active = await DataAccessCenter.securityKey.updateRegistry({
      keyId: descriptor.keyId,
      updates: { canaryEnvelope: createCanary(descriptor) },
    });
  }
  verifyCanary(active.canaryEnvelope, descriptor);
  await DataAccessCenter.securityKey.updateRegistry({
    keyId: descriptor.keyId,
    updates: { lastVerifiedAt: new Date() },
  });
  return active;
}

function keyRegistryCryptoMetadata(descriptor = {}) {
  const providerType = String(descriptor.providerType || "unknown");
  const hardwareProtection = /kms|vault|hsm|keychain|secure-enclave/i.test(
    providerType
  )
    ? "provider-asserted-hardware-backed"
    : /file|environment|env/i.test(providerType)
      ? "software-protected"
      : "unknown";
  return {
    algorithm: "AES-256-GCM",
    parameterSet: "AES-256/GCM-96+HKDF-SHA256",
    keyOrigin: providerType,
    hardwareProtection,
  };
}

function selectRuntimeDescriptor(providerDescriptor, activeRegistry = null) {
  if (!activeRegistry || activeRegistry.keyId === providerDescriptor?.keyId) {
    return providerDescriptor;
  }
  const registeredDescriptor = resolveKey(activeRegistry.keyId);
  if (!registeredDescriptor?.material) {
    throw new Error("key_registry_active_mismatch");
  }
  if (activeRegistry.canaryEnvelope) {
    verifyCanary(activeRegistry.canaryEnvelope, registeredDescriptor);
  }
  throw new Error("key_provider_registry_active_mismatch");
}

async function reconcileProviderWithRegistry({ apply = false } = {}) {
  clearRuntimeActiveKey();
  const providerDescriptor =
    keyProvider().resolveActiveKey(SERVER_DATA_PURPOSE);
  if (!providerDescriptor?.material) throw new Error("active_key_missing");
  const activeRegistry = await DataAccessCenter.securityKey.activeRegistry({
    purpose: SERVER_DATA_PURPOSE,
  });
  if (!activeRegistry || activeRegistry.keyId === providerDescriptor.keyId) {
    return {
      success: true,
      mode: apply ? "apply" : "dry-run",
      drift: false,
      activeKeyId: providerDescriptor.keyId,
    };
  }

  const registryDescriptor = resolveKey(activeRegistry.keyId);
  if (!registryDescriptor?.material) {
    throw new Error("key_registry_active_mismatch");
  }
  if (activeRegistry.canaryEnvelope) {
    verifyCanary(activeRegistry.canaryEnvelope, registryDescriptor);
  }
  if (!apply) {
    return {
      success: true,
      mode: "dry-run",
      drift: true,
      providerKeyId: providerDescriptor.keyId,
      registryKeyId: activeRegistry.keyId,
      action: "activate_registry_key_in_provider",
    };
  }

  const reconciled = activateKey(activeRegistry.keyId, SERVER_DATA_PURPOSE);
  await appendEvent("key_provider_registry_reconciled", reconciled, {
    previousProviderKeyId: providerDescriptor.keyId,
    registryKeyId: activeRegistry.keyId,
  });
  return {
    success: true,
    mode: "apply",
    drift: false,
    reconciled: true,
    previousProviderKeyId: providerDescriptor.keyId,
    activeKeyId: reconciled.keyId,
  };
}

async function persistBindings(descriptor, domains) {
  for (const result of domains) {
    await DataAccessCenter.securityKey.upsertBinding({
      domain: result.domain,
      purpose: SERVER_DATA_PURPOSE,
      activeKeyId: descriptor.keyId,
      envelopeVersion: "enc:v1+enc:v2",
      coverageState: result.state,
      coverage: result,
      lastVerifiedAt: new Date(),
    });
  }
}

async function runSecurityPreflight({
  runtimeRole = "api",
  allowGenerate = false,
} = {}) {
  clearRuntimeActiveKey();
  setSecurityState({
    status: "checking",
    runtimeRole,
    quarantined: false,
    reason: null,
  });
  let descriptor = resolveActiveKey();
  if (!descriptor && allowGenerate) {
    if (await encryptedDataExists()) {
      throw new Error("historical_ciphertext_exists_without_key");
    }
    if (typeof keyProvider().bootstrapKey !== "function") {
      throw new Error("key_provider_cannot_bootstrap");
    }
    descriptor = keyProvider().bootstrapKey();
  }
  if (!descriptor) throw new Error("encryption_master_key_missing");

  const activeRegistry = await DataAccessCenter.securityKey.activeRegistry({
    purpose: SERVER_DATA_PURPOSE,
  });
  descriptor = selectRuntimeDescriptor(descriptor, activeRegistry);
  setRuntimeActiveKey(descriptor);

  const registry = await ensureRegistry(descriptor);
  const domains = await probeDomains();
  const failed = domains.filter((item) => item.state === "failed");
  await persistBindings(descriptor, domains);
  if (failed.length) {
    throw new Error(
      `key_domain_probe_failed:${failed.map((item) => item.domain).join(",")}`
    );
  }
  await appendEvent("key_preflight_succeeded", descriptor, {
    runtimeRole,
    domains,
  });
  return setSecurityState({
    status: "ready",
    quarantined: false,
    reason: null,
    runtimeRole,
    provider: custodyHealth(),
    activeKey: {
      keyId: descriptor.keyId,
      fingerprint: descriptor.fingerprint,
      purpose: descriptor.purpose,
      version: registry.version,
      status: registry.status,
    },
    domains,
  });
}

async function bootstrapSecurityContext(options = {}) {
  const mode = String(
    process.env.ATHENA_KEY_PREFLIGHT_MODE || "enforce"
  ).toLowerCase();
  const {
    remoteCustodyStatus,
    remoteKeyCustodyEnabled,
  } = require("./keyCustody/remoteClient");
  if (remoteKeyCustodyEnabled(process.env)) {
    setSecurityState({
      status: "checking",
      runtimeRole: options.runtimeRole || null,
      quarantined: false,
      reason: null,
      provider: { remote: true },
      activeKey: null,
      domains: [],
    });
    try {
      const remote = await remoteCustodyStatus(process.env);
      return setSecurityState({
        status: "ready",
        quarantined: false,
        reason: null,
        runtimeRole: options.runtimeRole || null,
        provider: {
          remote: true,
          providerType: remote.providerType || null,
          mutable: remote.mutable === true,
          attested: remote.attested === true,
          leaseExpiresAt: remote.leaseExpiresAt || null,
          decryptOnlyKeyCount: Number(remote.decryptOnlyKeyCount || 0),
        },
        activeKey: null,
        domains: [
          {
            domain: "key-custody-service",
            state: "remote-authoritative",
            sample: false,
          },
        ],
      });
    } catch (error) {
      return setSecurityState({
        status: mode === "shadow" ? "degraded" : "quarantined",
        quarantined: mode !== "shadow",
        reason:
          error?.code || error?.message || "remote_key_custody_unavailable",
        runtimeRole: options.runtimeRole || null,
        provider: { remote: true },
        activeKey: null,
        domains: [],
      });
    }
  }
  try {
    return await runSecurityPreflight(options);
  } catch (error) {
    clearRuntimeActiveKey();
    const snapshot = setSecurityState({
      status: mode === "shadow" ? "degraded" : "quarantined",
      quarantined: mode !== "shadow",
      reason: error?.message || String(error),
      runtimeRole: options.runtimeRole || null,
      provider: custodyHealth(),
    });
    await appendEvent("key_preflight_failed", null, {
      runtimeRole: options.runtimeRole || null,
      reason: snapshot.reason,
      shadow: mode === "shadow",
    });
    return snapshot;
  }
}

function startSecurityBootstrap(options = {}) {
  const promise = bootstrapSecurityContext(options);
  setBootstrapPromise(promise);
  return promise;
}

async function keyGovernanceStatus({ limit = 50 } = {}) {
  const [registry, bindings, rotations, events] = await Promise.all([
    DataAccessCenter.securityKey.listRegistry({}),
    DataAccessCenter.securityKey.listBindings(),
    DataAccessCenter.securityKey.listRotationJobs({ limit }),
    DataAccessCenter.securityKey.listEvents({ limit }),
  ]);
  return {
    runtime: securityState(),
    provider: custodyHealth(),
    registry: registry.map(({ canaryEnvelope, ...item }) => ({
      ...item,
      hasCanary: Boolean(canaryEnvelope),
    })),
    bindings,
    rotations,
    events,
  };
}

async function prepareRotation({ idempotencyKey, createdBy = null } = {}) {
  const existing = await DataAccessCenter.securityKey.rotationJob({
    idempotencyKey,
  });
  if (existing) return existing;
  const approvalPolicy = rotationApprovalPolicy({ createdBy });
  const active = resolveActiveKey();
  if (!active) throw new Error("active_key_missing");
  const pending = generatePendingKey();
  await DataAccessCenter.securityKey.createRegistry({
    keyId: pending.keyId,
    purpose: SERVER_DATA_PURPOSE,
    providerType: pending.providerType,
    ...keyRegistryCryptoMetadata(pending),
    fingerprint: pending.fingerprint,
    version:
      (
        await DataAccessCenter.securityKey.listRegistry({
          purpose: SERVER_DATA_PURPOSE,
        })
      ).length + 1,
    status: "pending",
    canaryEnvelope: createCanary(pending),
    sourceDescriptor: custodyHealth().source,
    metadata: { rotationPending: true },
  });
  const jobId = `keyrot_${crypto.randomUUID()}`;
  const job = await DataAccessCenter.securityKey.createRotationJob({
    jobId,
    idempotencyKey,
    purpose: SERVER_DATA_PURPOSE,
    sourceKeyId: active.keyId,
    targetKeyId: pending.keyId,
    status: "pending",
    stage: "prepare",
    progress: { domains: DEFAULT_DOMAINS, writeBarrier: false },
    createdBy,
    ...approvalPolicy,
  });
  await DataAccessCenter.securityKey.appendEvent({
    event: "key_rotation_prepared",
    keyId: pending.keyId,
    purpose: SERVER_DATA_PURPOSE,
    jobId,
    metadata: { sourceKeyId: active.keyId },
    createdBy,
  });
  return job;
}

async function approveRotation({
  jobId,
  approvalId,
  approvedBy,
  metadata = null,
} = {}) {
  const job = await DataAccessCenter.securityKey.rotationJob({ jobId });
  if (!job) throw new Error("key_rotation_job_not_found");
  if (!["pending", "approved"].includes(job.status))
    throw new Error("key_rotation_not_approvable");
  const actor = Number(approvedBy);
  if (!Number.isSafeInteger(actor) || actor < 1)
    throw new Error("key_rotation_approver_required");
  if (actor === Number(job.createdBy))
    throw new Error("key_rotation_self_approval_forbidden");
  if (!String(approvalId || "").trim())
    throw new Error("key_rotation_approval_id_required");
  const deadline = Date.parse(job.approvalExpiresAt);
  if (!Number.isFinite(deadline) || deadline <= Date.now())
    throw new Error("key_rotation_approval_expired");
  const result = await DataAccessCenter.securityKey.recordRotationApproval({
    jobId: job.jobId,
    approvalId: String(approvalId).slice(0, 256),
    approverUserId: actor,
    expiresAt: new Date(deadline),
    metadata,
  });
  await DataAccessCenter.securityKey.appendEvent({
    event: "key_rotation_approved",
    keyId: job.targetKeyId,
    purpose: job.purpose,
    jobId: job.jobId,
    metadata: {
      approvalCount: result.approvalCount,
      requiredApprovals: job.requiredApprovals,
    },
    createdBy: actor,
  });
  return result;
}

async function assertRotationExecutionAuthorized({
  job,
  actorUserId = null,
} = {}) {
  const approvals = await DataAccessCenter.securityKey.rotationApprovals({
    jobId: job?.jobId,
  });
  const authorization = rotationExecutionAuthorization({
    job,
    approvals,
    actorUserId,
  });
  if (!authorization.authorized) {
    const error = new Error(authorization.reason);
    error.code = authorization.reason;
    throw error;
  }
  return authorization;
}

module.exports = {
  CANARY_VERSION,
  approveRotation,
  assertRotationExecutionAuthorized,
  bootstrapSecurityContext,
  createCanary,
  decryptEnvelopeWithCustody,
  keyDualControlRequired,
  keyGovernanceStatus,
  prepareRotation,
  probeDomains,
  reconcileProviderWithRegistry,
  runSecurityPreflight,
  rotationApprovalPolicy,
  rotationExecutionAuthorization,
  selectRuntimeDescriptor,
  startSecurityBootstrap,
  verifyCanary,
};
