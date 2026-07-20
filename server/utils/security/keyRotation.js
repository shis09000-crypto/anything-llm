const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const prisma = require("../prisma");
const { DataAccessCenter } = require("../dataAccess");
const { storagePath } = require("../environment");
const { FIELD_SPECS } = require("./mixedKeyDatabaseRecovery");
const { activateKey, resolveActiveKey, resolveKey } = require("./keyCustody");
const { SERVER_DATA_PURPOSE } = require("./keyCustody/providers");
const { probeDomains } = require("./keyLifecycle");
const { setRotationWriteBarrier } = require("./keyRuntimeState");

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

function wrapperMutation({ value, source, target, defaultPurpose }) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.encryptedPayload !== "string") return null;
  const envelope = parseEnvelope(value.encryptedPayload);
  if (envelope.keyId === target.keyId) return null;
  const decoded = decryptEnvelope(value.encryptedPayload, source);
  let embeddedDomain = null;
  try {
    embeddedDomain = JSON.parse(decoded.plaintext)?.domain || null;
  } catch {}
  return {
    ...value,
    encryptedPayload: encryptEnvelope(
      decoded.plaintext,
      target,
      decoded.purpose || embeddedDomain || defaultPurpose
    ),
  };
}

async function scanDatabase(source, target) {
  const mutations = [];
  for (const spec of FIELD_SPECS) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT "id", "${spec.field}" AS "value" FROM "${spec.table}"
       WHERE "${spec.field}" LIKE 'enc:%' ORDER BY "id" ASC`
    );
    for (const row of rows) {
      const parsed = parseEnvelope(row.value);
      if (parsed.keyId === target.keyId) continue;
      const decoded = decryptEnvelope(row.value, source);
      mutations.push({
        ...spec,
        id: row.id,
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
    documentFiles: 0,
    vectorCacheFiles: 0,
    lanceRows: 0,
  };

  for (const spec of FIELD_SPECS) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT "${spec.field}" AS "value" FROM "${spec.table}"
       WHERE "${spec.field}" LIKE 'enc:%'`
    );
    for (const row of rows) {
      decryptEnvelope(row.value, active);
      coverage.databaseSecrets += 1;
    }
  }

  for (const [coverageKey, root] of [
    ["documentFiles", storagePath("documents")],
    ["vectorCacheFiles", storagePath("vector-cache")],
  ]) {
    for (const filePath of jsonFiles(root)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (typeof parsed?.encryptedPayload !== "string") continue;
      decryptEnvelope(parsed.encryptedPayload, active);
      coverage[coverageKey] += 1;
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
          if (typeof wrapper?.encryptedPayload !== "string") continue;
          decryptEnvelope(wrapper.encryptedPayload, active);
          coverage.lanceRows += 1;
        }
      }
    } finally {
      await client.close();
    }
  }

  return coverage;
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

async function appendRotationEvent(job, event, metadata = {}) {
  return DataAccessCenter.securityKey.appendEvent({
    event,
    keyId: job.targetKeyId,
    purpose: job.purpose,
    jobId: job.jobId,
    metadata,
    createdBy: job.createdBy,
  });
}

async function executeRotationJob({ jobId }) {
  let job = await DataAccessCenter.securityKey.rotationJob({ jobId });
  if (!job) throw new Error("key_rotation_job_not_found");
  if (job.status === "completed") return job;
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

    await prisma.$transaction(async (transaction) => {
      for (const item of database) {
        const changed = await transaction.$executeRawUnsafe(
          `UPDATE "${item.table}" SET "${item.field}" = ?
           WHERE "id" = ? AND "${item.field}" = ?`,
          item.nextValue,
          item.id,
          item.previousValue
        );
        if (Number(changed) !== 1) {
          throw new Error(
            `key_rotation_write_conflict:${item.table}.${item.field}:${item.id}`
          );
        }
      }
    });

    await persistStage(job.jobId, "reencrypt", {
      writeBarrier: true,
      totals,
      databaseComplete: true,
    });
    for (const item of files) atomicJsonWrite(item.filePath, item.next);
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
  executeRotationJob,
  parseEnvelope,
  verifyAllKeyDomains,
};
