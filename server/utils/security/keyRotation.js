const crypto = require("crypto");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const prisma = require("../prisma");
const authPrisma = require("../authPrisma");
const { DataAccessCenter } = require("../dataAccess");
const { managedEnvironmentPath, storagePath } = require("../environment");
const { FIELD_SPECS } = require("./mixedKeyDatabaseRecovery");
const { activateKey, resolveActiveKey, resolveKey } = require("./keyCustody");
const { SERVER_DATA_PURPOSE } = require("./keyCustody/providers");
const {
  assertRotationExecutionAuthorized,
  probeDomains,
} = require("./keyLifecycle");
const { setRotationWriteBarrier } = require("./keyRuntimeState");
const { resignSecurityAuditCheckpoints } = require("./auditLedger");

function parseEnvelope(value) {
  const parts = String(value || "").split(":");
  if (parts[0] !== "enc")
    throw new Error("unsupported_encrypted_secret_format");
  if (parts[1] === "v1" && parts.length === 5) {
    return {
      version: "v1",
      keyId: null,
      purpose: null,
      iv: parts[2],
      authTag: parts[3],
      ciphertext: parts[4],
    };
  }
  if (parts[1] === "v2" && parts.length === 7) {
    return {
      version: "v2",
      keyId: parts[2],
      purpose: Buffer.from(parts[3], "base64url").toString("utf8"),
      iv: parts[4],
      authTag: parts[5],
      ciphertext: parts[6],
    };
  }
  throw new Error("unsupported_encrypted_secret_format");
}

function envelopeAad(keyId, purpose) {
  return Buffer.from(
    JSON.stringify({ version: "enc:v2", keyId, purpose }),
    "utf8"
  );
}

function decryptEnvelope(value, legacyDescriptor) {
  const envelope = parseEnvelope(value);
  const descriptor = envelope.keyId
    ? resolveKey(envelope.keyId)
    : legacyDescriptor;
  if (!descriptor?.material) throw new Error("rotation_source_key_unavailable");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    descriptor.material,
    Buffer.from(envelope.iv, "base64url")
  );
  if (envelope.version === "v2") {
    decipher.setAAD(envelopeAad(envelope.keyId, envelope.purpose));
  }
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
  return {
    plaintext: Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8"),
    purpose: envelope.purpose,
    keyId: descriptor.keyId,
  };
}

function encryptEnvelope(plaintext, descriptor, purpose) {
  const iv = crypto.randomBytes(12);
  const normalizedPurpose = String(purpose || "secret-store").slice(0, 128);
  const cipher = crypto.createCipheriv("aes-256-gcm", descriptor.material, iv);
  cipher.setAAD(envelopeAad(descriptor.keyId, normalizedPurpose));
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  return [
    "enc:v2",
    descriptor.keyId,
    Buffer.from(normalizedPurpose, "utf8").toString("base64url"),
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

function jsonFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.name.endsWith(".json")) files.push(target);
    }
  };
  visit(root);
  return files;
}

function atomicJsonWrite(filePath, payload) {
  const mode = fs.statSync(filePath).mode & 0o777;
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: mode || 0o600,
  });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, mode || 0o600);
}

function atomicTextWrite(filePath, content) {
  const mode = fs.statSync(filePath).mode & 0o777;
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, {
    encoding: "utf8",
    mode: mode || 0o600,
  });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, mode || 0o600);
}

function wrapperMutation({ value, source, target, defaultPurpose }) {
  if (!value || typeof value !== "object") return null;
  let changed = false;
  const next = { ...value };
  for (const location of ["direct", "nested"]) {
    const container = location === "direct" ? next : next.payload;
    if (typeof container?.encryptedPayload !== "string") continue;
    const envelope = parseEnvelope(container.encryptedPayload);
    if (envelope.keyId === target.keyId) continue;
    const decoded = decryptEnvelope(container.encryptedPayload, source);
    let embeddedDomain = null;
    try {
      embeddedDomain = JSON.parse(decoded.plaintext)?.domain || null;
    } catch {}
    const nextContainer = {
      ...container,
      encryptedPayload: encryptEnvelope(
        decoded.plaintext,
        target,
        decoded.purpose || embeddedDomain || defaultPurpose
      ),
    };
    if (location === "direct")
      next.encryptedPayload = nextContainer.encryptedPayload;
    else next.payload = nextContainer;
    changed = true;
  }
  return changed ? next : null;
}

function encryptedTreeMutation({ value, source, target, defaultPurpose }) {
  if (typeof value === "string") {
    if (!value.startsWith("enc:")) return { value, changed: 0 };
    const envelope = parseEnvelope(value);
    if (envelope.keyId === target.keyId) return { value, changed: 0 };
    const decoded = decryptEnvelope(value, source);
    return {
      value: encryptEnvelope(
        decoded.plaintext,
        target,
        decoded.purpose || defaultPurpose
      ),
      changed: 1,
    };
  }
  if (Array.isArray(value)) {
    let changed = 0;
    const next = value.map((item) => {
      const mutation = encryptedTreeMutation({
        value: item,
        source,
        target,
        defaultPurpose,
      });
      changed += mutation.changed;
      return mutation.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (value && typeof value === "object") {
    let changed = 0;
    const next = {};
    for (const [key, item] of Object.entries(value)) {
      const mutation = encryptedTreeMutation({
        value: item,
        source,
        target,
        defaultPurpose,
      });
      changed += mutation.changed;
      next[key] = mutation.value;
    }
    return { value: changed ? next : value, changed };
  }
  return { value, changed: 0 };
}

function envFileMutation({ content, source, target }) {
  const parsed = dotenv.parse(String(content || ""));
  const mutation = encryptedTreeMutation({
    value: parsed,
    source,
    target,
    defaultPurpose: "managed-environment-secret",
  });
  if (!mutation.changed) return null;
  let next = String(content || "");
  for (const [key, value] of Object.entries(mutation.value)) {
    if (value === parsed[key] || typeof value !== "string") continue;
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^(\\s*${escapedKey}\\s*=\\s*).*$`, "m");
    if (!pattern.test(next)) throw new Error("managed_env_key_missing");
    next = next.replace(pattern, `$1'${value}'`);
  }
  return next;
}

async function scanDatabase(source, target) {
  const mutations = [];
  for (const spec of FIELD_SPECS) {
    const client = spec.database === "auth" ? authPrisma : prisma;
    const resourceIdSelection = spec.resourceIdField
      ? `, "${spec.resourceIdField}" AS "resourceId"`
      : "";
    const rows = await client.$queryRawUnsafe(
      `SELECT "id", "${spec.field}" AS "value"${resourceIdSelection} FROM "${spec.table}"
       WHERE "${spec.field}" LIKE 'enc:%' ORDER BY "id" ASC`
    );
    for (const row of rows) {
      const parsed = parseEnvelope(row.value);
      if (parsed.keyId === target.keyId) continue;
      const decoded = decryptEnvelope(row.value, source);
      mutations.push({
        ...spec,
        id: row.id,
        resourceId: row.resourceId ? String(row.resourceId) : null,
        previousValue: row.value,
        nextValue: encryptEnvelope(
          decoded.plaintext,
          target,
          decoded.purpose || spec.purpose
        ),
      });
    }
  }
  return mutations;
}

function scanFileStores(source, target) {
  const mutations = [];
  for (const [domain, root] of [
    ["document-store", storagePath("documents")],
    ["vector-cache", storagePath("vector-cache")],
  ]) {
    for (const filePath of jsonFiles(root)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const next = wrapperMutation({
        value: parsed,
        source,
        target,
        defaultPurpose: domain,
      });
      if (next) mutations.push({ domain, filePath, next });
    }
  }
  const providerBackup = storagePath("system", "provider-settings.backup.json");
  if (fs.existsSync(providerBackup)) {
    const parsed = JSON.parse(fs.readFileSync(providerBackup, "utf8"));
    const mutation = encryptedTreeMutation({
      value: parsed,
      source,
      target,
      defaultPurpose: "provider-settings-backup",
    });
    if (mutation.changed) {
      mutations.push({
        domain: "provider-settings-backup",
        filePath: providerBackup,
        next: mutation.value,
      });
    }
  }
  const managedEnv = managedEnvironmentPath();
  if (fs.existsSync(managedEnv)) {
    const nextText = envFileMutation({
      content: fs.readFileSync(managedEnv, "utf8"),
      source,
      target,
    });
    if (nextText) {
      mutations.push({
        domain: "managed-environment",
        filePath: managedEnv,
        nextText,
      });
    }
  }
  return mutations;
}

async function scanLanceDb(source, target) {
  const root = storagePath("lancedb");
  if (!fs.existsSync(root)) return [];
  const lancedb = require("@lancedb/lancedb");
  const client = await lancedb.connect(root);
  const mutations = [];
  try {
    for (const tableName of await client.tableNames()) {
      const table = await client.openTable(tableName);
      const count = await table.countRows();
      const rows = count > 0 ? await table.query().limit(count).toArray() : [];
      for (const row of rows) {
        if (!row?.id || typeof row.text !== "string") continue;
        let wrapper;
        try {
          wrapper = JSON.parse(row.text);
        } catch {
          continue;
        }
        const next = wrapperMutation({
          value: wrapper,
          source,
          target,
          defaultPurpose: "vector-provider-text",
        });
        if (next) {
          mutations.push({
            tableName,
            id: String(row.id),
            nextText: JSON.stringify(next),
          });
        }
      }
    }
    return mutations;
  } finally {
    await client.close();
  }
}

async function applyLanceMutations(mutations = []) {
  if (!mutations.length) return;
  const lancedb = require("@lancedb/lancedb");
  const client = await lancedb.connect(storagePath("lancedb"));
  const tables = new Map();
  try {
    for (const item of mutations) {
      let table = tables.get(item.tableName);
      if (!table) {
        table = await client.openTable(item.tableName);
        tables.set(item.tableName, table);
      }
      await table.update({
        where: `id = ${sqlString(item.id)}`,
        values: { text: item.nextText },
      });
    }
  } finally {
    await client.close();
  }
}

async function verifyAllKeyDomains() {
  const active = resolveActiveKey();
  if (!active?.material) throw new Error("active_key_missing");
  const coverage = {
    databaseSecrets: 0,
    sharedAuthSecrets: 0,
    documentFiles: 0,
    vectorCacheFiles: 0,
    providerBackupValues: 0,
    managedEnvValues: 0,
    lanceRows: 0,
  };
  const attempted = Object.fromEntries(
    Object.keys(coverage).map((key) => [key, 0])
  );
  const failures = [];
  const resourceHash = (value) =>
    crypto
      .createHash("sha256")
      .update(String(value))
      .digest("hex")
      .slice(0, 16);
  const failureReason = (error) => {
    if (error?.message === "unsupported_encrypted_secret_format")
      return "format_invalid";
    if (error?.message === "rotation_source_key_unavailable")
      return "key_unavailable";
    return "authentication_failed";
  };
  const verify = ({ coverageKey, value, domain, resource }) => {
    attempted[coverageKey] += 1;
    try {
      decryptEnvelope(value, active);
      coverage[coverageKey] += 1;
    } catch (error) {
      let envelope = null;
      try {
        envelope = parseEnvelope(value);
      } catch {}
      failures.push({
        domain,
        resourceHash: resourceHash(resource),
        envelopeVersion: envelope?.version || null,
        keyId: envelope?.keyId || null,
        reason: failureReason(error),
      });
    }
  };

  for (const spec of FIELD_SPECS) {
    const client = spec.database === "auth" ? authPrisma : prisma;
    const rows = await client.$queryRawUnsafe(
      `SELECT "id", "${spec.field}" AS "value" FROM "${spec.table}"
       WHERE "${spec.field}" LIKE 'enc:%'`
    );
    for (const row of rows) {
      verify({
        coverageKey:
          spec.database === "auth" ? "sharedAuthSecrets" : "databaseSecrets",
        value: row.value,
        domain: `${spec.database || "main"}:${spec.table}.${spec.field}`,
        resource: `${spec.database || "main"}:${spec.table}:${row.id}`,
      });
    }
  }

  const providerBackup = storagePath("system", "provider-settings.backup.json");
  if (fs.existsSync(providerBackup)) {
    const parsed = JSON.parse(fs.readFileSync(providerBackup, "utf8"));
    const visit = (value, location = "$") => {
      if (typeof value === "string" && value.startsWith("enc:")) {
        verify({
          coverageKey: "providerBackupValues",
          value,
          domain: "provider-settings-backup",
          resource: location,
        });
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${location}[${index}]`));
        return;
      }
      if (value && typeof value === "object") {
        for (const [key, item] of Object.entries(value))
          visit(item, `${location}.${key}`);
      }
    };
    visit(parsed);
  }

  const managedEnv = managedEnvironmentPath();
  if (fs.existsSync(managedEnv)) {
    const parsed = dotenv.parse(fs.readFileSync(managedEnv, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string" || !value.startsWith("enc:")) continue;
      verify({
        coverageKey: "managedEnvValues",
        value,
        domain: "managed-environment",
        resource: key,
      });
    }
  }

  for (const [coverageKey, root] of [
    ["documentFiles", storagePath("documents")],
    ["vectorCacheFiles", storagePath("vector-cache")],
  ]) {
    for (const filePath of jsonFiles(root)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      for (const encryptedPayload of [
        parsed?.encryptedPayload,
        parsed?.payload?.encryptedPayload,
      ].filter((value) => typeof value === "string")) {
        verify({
          coverageKey,
          value: encryptedPayload,
          domain:
            coverageKey === "documentFiles" ? "document-store" : "vector-cache",
          resource: path.relative(storagePath(), filePath),
        });
      }
    }
  }

  const lanceRoot = storagePath("lancedb");
  if (fs.existsSync(lanceRoot)) {
    const lancedb = require("@lancedb/lancedb");
    const client = await lancedb.connect(lanceRoot);
    try {
      for (const tableName of await client.tableNames()) {
        const table = await client.openTable(tableName);
        const count = await table.countRows();
        const rows =
          count > 0 ? await table.query().limit(count).toArray() : [];
        for (const row of rows) {
          if (typeof row?.text !== "string") continue;
          let wrapper;
          try {
            wrapper = JSON.parse(row.text);
          } catch {
            continue;
          }
          for (const encryptedPayload of [
            wrapper?.encryptedPayload,
            wrapper?.payload?.encryptedPayload,
          ].filter((value) => typeof value === "string")) {
            verify({
              coverageKey: "lanceRows",
              value: encryptedPayload,
              domain: "lancedb",
              resource: `${tableName}:${row.id || "missing-id"}`,
            });
          }
        }
      }
    } finally {
      await client.close();
    }
  }

  return {
    ok: failures.length === 0,
    activeKeyId: active.keyId,
    attempted,
    verified: coverage,
    failureCount: failures.length,
    failures,
  };
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function persistStage(jobId, stage, progress = {}, status = "running") {
  return DataAccessCenter.securityKey.updateRotationJob({
    jobId,
    updates: { stage, status, progress, failure: null },
  });
}

async function appendRotationEvent(
  job,
  event,
  metadata = {},
  createdBy = job.createdBy
) {
  return DataAccessCenter.securityKey.appendEvent({
    event,
    keyId: job.targetKeyId,
    purpose: job.purpose,
    jobId: job.jobId,
    metadata,
    createdBy,
  });
}

async function executeRotationJob({ jobId, actorUserId = null }) {
  let job = await DataAccessCenter.securityKey.rotationJob({ jobId });
  if (!job) throw new Error("key_rotation_job_not_found");
  if (job.status === "completed") return job;
  const authorization = await assertRotationExecutionAuthorized({
    job,
    actorUserId,
  });
  job = await DataAccessCenter.securityKey.claimRotationExecution({
    jobId: job.jobId,
    actorUserId,
    progress: {
      ...(job.progress || {}),
      approvalCount: authorization.approvalCount,
    },
  });
  await appendRotationEvent(
    job,
    "key_rotation_execution_authorized",
    {
      approvalCount: authorization.approvalCount,
      executorPresent: Boolean(actorUserId),
    },
    actorUserId
  );
  const source = resolveKey(job.sourceKeyId);
  const target = resolveKey(job.targetKeyId);
  if (!source?.material || !target?.material) {
    throw new Error("key_rotation_material_unavailable");
  }
  if (source.keyId === target.keyId) throw new Error("key_rotation_keys_equal");

  setRotationWriteBarrier(true, job.jobId);
  try {
    job = await persistStage(job.jobId, "write_barrier", {
      writeBarrier: true,
    });
    await appendRotationEvent(job, "key_rotation_write_barrier_enabled");

    await persistStage(job.jobId, "scan", { writeBarrier: true });
    const database = await scanDatabase(source, target);
    const files = scanFileStores(source, target);
    const lance = await scanLanceDb(source, target);
    const totals = {
      database: database.length,
      files: files.length,
      lance: lance.length,
    };
    await persistStage(job.jobId, "rewrap", { writeBarrier: true, totals });
    const auditCheckpoints = await resignSecurityAuditCheckpoints({
      sourceKeyId: source.keyId,
      targetKeyId: target.keyId,
    });
    totals.auditCheckpoints = auditCheckpoints.migrated;

    for (const [databaseName, client] of [
      ["main", prisma],
      ["auth", authPrisma],
    ]) {
      const mutations = database.filter(
        (item) => (item.database || "main") === databaseName
      );
      if (!mutations.length) continue;
      await client.$transaction(async (transaction) => {
        for (const item of mutations) {
          const changed = await transaction.$executeRawUnsafe(
            `UPDATE "${item.table}" SET "${item.field}" = ?
           WHERE "id" = ? AND "${item.field}" = ?`,
            item.nextValue,
            item.id,
            item.previousValue
          );
          if (Number(changed) !== 1) {
            throw new Error(
              `key_rotation_write_conflict:${databaseName}:${item.table}.${item.field}:${item.id}`
            );
          }
          if (item.resourceType && item.resourceId) {
            await transaction.user_domain_key_wraps.updateMany({
              where: {
                resourceType: item.resourceType,
                resourceId: item.resourceId,
                platformKeyId: source.keyId,
              },
              data: {
                platformWrapVersion: "enc:v2",
                platformKeyId: target.keyId,
                updatedAt: new Date(),
              },
            });
          }
        }
      });
    }

    await persistStage(job.jobId, "reencrypt", {
      writeBarrier: true,
      totals,
      databaseComplete: true,
    });
    for (const item of files) {
      if (typeof item.nextText === "string")
        atomicTextWrite(item.filePath, item.nextText);
      else atomicJsonWrite(item.filePath, item.next);
    }
    await applyLanceMutations(lance);

    await persistStage(job.jobId, "verify", {
      writeBarrier: true,
      totals,
      rewritten: true,
    });
    const residualDatabase = await scanDatabase(source, target);
    const residualFiles = scanFileStores(source, target);
    const residualLance = await scanLanceDb(source, target);
    if (
      residualDatabase.length ||
      residualFiles.length ||
      residualLance.length
    ) {
      throw new Error("key_rotation_verification_incomplete");
    }

    await persistStage(job.jobId, "activate", {
      writeBarrier: true,
      totals,
      verified: true,
    });
    const activated = activateKey(target.keyId);
    await DataAccessCenter.securityKey.updateRegistry({
      keyId: source.keyId,
      updates: { status: "decrypt_only" },
    });
    await DataAccessCenter.securityKey.updateRegistry({
      keyId: target.keyId,
      updates: {
        status: "active",
        activatedAt: new Date(),
        lastVerifiedAt: new Date(),
      },
    });
    const domains = await probeDomains();
    if (domains.some((item) => item.state === "failed")) {
      activateKey(source.keyId);
      await DataAccessCenter.securityKey.updateRegistry({
        keyId: source.keyId,
        updates: { status: "active", activatedAt: new Date() },
      });
      await DataAccessCenter.securityKey.updateRegistry({
        keyId: target.keyId,
        updates: { status: "pending", activatedAt: null },
      });
      throw new Error("key_rotation_post_activation_probe_failed");
    }
    for (const domain of domains) {
      await DataAccessCenter.securityKey.upsertBinding({
        domain: domain.domain,
        purpose: SERVER_DATA_PURPOSE,
        activeKeyId: activated.keyId,
        envelopeVersion: "enc:v2",
        coverageState: domain.state,
        coverage: domain,
        lastVerifiedAt: new Date(),
      });
    }

    job = await DataAccessCenter.securityKey.updateRotationJob({
      jobId: job.jobId,
      updates: {
        stage: "completed",
        status: "completed",
        progress: {
          writeBarrier: false,
          totals,
          verified: true,
          sourceStatus: "decrypt_only",
        },
        completedAt: new Date(),
      },
    });
    await appendRotationEvent(job, "key_rotation_completed", {
      sourceKeyId: source.keyId,
      totals,
    });
    return job;
  } catch (error) {
    await DataAccessCenter.securityKey.updateRotationJob({
      jobId: job.jobId,
      updates: {
        status: "failed",
        executionStartedBy: null,
        failure: JSON.stringify({
          message: error?.message || String(error),
          failedAt: new Date().toISOString(),
        }),
      },
    });
    await appendRotationEvent(job, "key_rotation_failed", {
      reason: error?.message || String(error),
    });
    throw error;
  } finally {
    setRotationWriteBarrier(false);
  }
}

module.exports = {
  decryptEnvelope,
  encryptEnvelope,
  encryptedTreeMutation,
  envFileMutation,
  executeRotationJob,
  parseEnvelope,
  verifyAllKeyDomains,
  wrapperMutation,
};
