const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { MASTER_KEY_ENV } = require("../constants");
const { EncryptionConfigError } = require("../errors");

const SERVER_DATA_PURPOSE = "server-data-at-rest";
const KEYRING_VERSION = "athena-keyring:v1";

function normalizeKey(value, label = MASTER_KEY_ENV) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new EncryptionConfigError(`${label} must be a 64-character hex key.`);
  }
  return normalized;
}

function fingerprint(value) {
  const normalized = normalizeKey(value);
  if (!normalized) return null;
  return crypto
    .createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 12);
}

function keyIdFor(value, purpose = SERVER_DATA_PURPOSE) {
  const prefix = purpose === SERVER_DATA_PURPOSE ? "sdk" : "key";
  return `${prefix}_${fingerprint(value)}`;
}

function serverRoot() {
  return path.resolve(__dirname, "../../..");
}

function defaultEnvPath(env = process.env, root = serverRoot()) {
  const appEnv = String(env.APP_ENV || env.NODE_ENV || "")
    .trim()
    .toLowerCase();
  if (appEnv === "development") {
    return path.join(root, ".env.development");
  }
  const configured = env.DESKTOP_ENV_PATH || ".env";
  return path.isAbsolute(configured) ? configured : path.join(root, configured);
}

function parseEnv(content = "") {
  const values = {};
  for (const line of String(content).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return values;
}

function safeFileMode(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return fs.statSync(filePath).mode & 0o777;
}

function assertSecureFile(filePath, { allowMissing = false } = {}) {
  if (!fs.existsSync(filePath)) {
    if (allowMissing) return null;
    throw new EncryptionConfigError(`Key source is missing: ${filePath}`);
  }
  const mode = safeFileMode(filePath);
  if ((mode & 0o077) !== 0) {
    throw new EncryptionConfigError(
      `Key source permissions must be 0400 or 0600: ${filePath}`
    );
  }
  return mode;
}

function atomicWrite(filePath, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, value, { mode, encoding: "utf8" });
  fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, mode);
}

function replaceEnvValue(content, name, value) {
  const lines = String(content || "").split(/\r?\n/);
  const pattern = new RegExp(`^\\s*${name}\\s*=`);
  let replaced = false;
  const next = lines
    .map((line) => {
      if (!pattern.test(line)) return line;
      if (replaced) return null;
      replaced = true;
      return `${name}=${value}`;
    })
    .filter((line) => line !== null);
  if (!replaced) next.push(`${name}=${value}`);
  return `${next.join("\n").replace(/\n+$/, "")}\n`;
}

function readKeyring(filePath) {
  if (!fs.existsSync(filePath)) return null;
  assertSecureFile(filePath);
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (parsed?.format !== KEYRING_VERSION || typeof parsed.keys !== "object") {
    throw new EncryptionConfigError("Unsupported Athena keyring format.");
  }
  return parsed;
}

class EnvFileKeyProvider {
  constructor({ env = process.env, envPath = null } = {}) {
    this.env = env;
    this.envPath = path.resolve(envPath || defaultEnvPath(env));
    this.keyringPath = path.resolve(
      env.ATHENA_KEYRING_PATH || `${this.envPath}.keyring.json`
    );
    this.providerType = "env-file";
  }

  sourceValue() {
    if (!fs.existsSync(this.envPath)) return null;
    assertSecureFile(this.envPath);
    return normalizeKey(
      parseEnv(fs.readFileSync(this.envPath, "utf8"))[MASTER_KEY_ENV]
    );
  }

  assertNoConflict() {
    const persisted = this.sourceValue();
    const ambient = normalizeKey(this.env[MASTER_KEY_ENV]);
    if (persisted && ambient && persisted !== ambient) {
      throw new EncryptionConfigError(
        "key_source_conflict: persisted and process keys differ"
      );
    }
    return persisted || ambient;
  }

  descriptorFor(material, status = "active") {
    if (!material) return null;
    return {
      keyId: keyIdFor(material),
      purpose: SERVER_DATA_PURPOSE,
      fingerprint: fingerprint(material),
      status,
      providerType: this.providerType,
      material: Buffer.from(material, "hex"),
    };
  }

  resolveActiveKey() {
    const material = this.assertNoConflict();
    if (!material) return null;
    const ring = readKeyring(this.keyringPath);
    const descriptor = this.descriptorFor(material);
    if (ring?.activeKeyId && ring.activeKeyId !== descriptor.keyId) {
      throw new EncryptionConfigError("keyring_active_key_conflict");
    }
    return descriptor;
  }

  resolveKey(keyId) {
    const active = this.resolveActiveKey();
    if (active?.keyId === keyId) return active;
    const ring = readKeyring(this.keyringPath);
    const entry = ring?.keys?.[keyId];
    if (!entry?.material) return null;
    const material = normalizeKey(entry.material, `keyring:${keyId}`);
    const descriptor = this.descriptorFor(
      material,
      entry.status || "decrypt_only"
    );
    if (descriptor.keyId !== keyId) {
      throw new EncryptionConfigError("keyring_key_id_mismatch");
    }
    return descriptor;
  }

  bootstrapKey() {
    if (this.resolveActiveKey()) return this.resolveActiveKey();
    const material = crypto.randomBytes(32).toString("hex");
    const existing = fs.existsSync(this.envPath)
      ? fs.readFileSync(this.envPath, "utf8")
      : "";
    atomicWrite(
      this.envPath,
      replaceEnvValue(existing, MASTER_KEY_ENV, material)
    );
    this.env[MASTER_KEY_ENV] = material;
    return this.descriptorFor(material);
  }

  ensureKeyring() {
    const active = this.resolveActiveKey();
    if (!active)
      throw new EncryptionConfigError(`${MASTER_KEY_ENV} is required.`);
    const existing = readKeyring(this.keyringPath);
    if (existing) return existing;
    const ring = {
      format: KEYRING_VERSION,
      activeKeyId: active.keyId,
      keys: {
        [active.keyId]: {
          material: active.material.toString("hex"),
          status: "active",
          createdAt: new Date().toISOString(),
        },
      },
    };
    atomicWrite(this.keyringPath, `${JSON.stringify(ring, null, 2)}\n`);
    return ring;
  }

  generatePendingKey() {
    const ring = this.ensureKeyring();
    const material = crypto.randomBytes(32).toString("hex");
    const descriptor = this.descriptorFor(material, "pending");
    ring.keys[descriptor.keyId] = {
      material,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    atomicWrite(this.keyringPath, `${JSON.stringify(ring, null, 2)}\n`);
    return descriptor;
  }

  activateKey(keyId) {
    const ring = this.ensureKeyring();
    const target = ring.keys[keyId];
    if (!target?.material)
      throw new EncryptionConfigError("keyring_key_not_found");
    for (const [id, entry] of Object.entries(ring.keys)) {
      if (entry.status === "active") entry.status = "decrypt_only";
      if (id === keyId) entry.status = "active";
    }
    ring.activeKeyId = keyId;
    const existing = fs.readFileSync(this.envPath, "utf8");
    atomicWrite(
      this.envPath,
      replaceEnvValue(existing, MASTER_KEY_ENV, target.material)
    );
    atomicWrite(this.keyringPath, `${JSON.stringify(ring, null, 2)}\n`);
    this.env[MASTER_KEY_ENV] = target.material;
    return this.resolveActiveKey();
  }

  retireKey(keyId) {
    const ring = this.ensureKeyring();
    if (ring.activeKeyId === keyId) {
      throw new EncryptionConfigError("cannot_retire_active_key");
    }
    if (!ring.keys[keyId])
      throw new EncryptionConfigError("keyring_key_not_found");
    ring.keys[keyId].status = "retired";
    ring.keys[keyId].retiredAt = new Date().toISOString();
    atomicWrite(this.keyringPath, `${JSON.stringify(ring, null, 2)}\n`);
    return true;
  }

  exportRecoveryState() {
    const active = this.resolveActiveKey();
    if (!active) throw new EncryptionConfigError("active_key_missing");
    return {
      format: "athena-key-recovery-state:v1",
      activeKeyId: active.keyId,
      activeMaterial: active.material.toString("hex"),
      keyring: readKeyring(this.keyringPath),
      exportedAt: new Date().toISOString(),
    };
  }

  restoreRecoveryState(state = {}) {
    if (state.format !== "athena-key-recovery-state:v1") {
      throw new EncryptionConfigError("unsupported_key_recovery_state");
    }
    const material = normalizeKey(state.activeMaterial, "recovery active key");
    if (keyIdFor(material) !== state.activeKeyId) {
      throw new EncryptionConfigError("recovery_key_identity_mismatch");
    }
    const existing = fs.existsSync(this.envPath)
      ? fs.readFileSync(this.envPath, "utf8")
      : "";
    atomicWrite(
      this.envPath,
      replaceEnvValue(existing, MASTER_KEY_ENV, material)
    );
    if (state.keyring) {
      if (state.keyring.format !== KEYRING_VERSION) {
        throw new EncryptionConfigError("unsupported_recovery_keyring");
      }
      atomicWrite(
        this.keyringPath,
        `${JSON.stringify(state.keyring, null, 2)}\n`
      );
    }
    this.env[MASTER_KEY_ENV] = material;
    return this.resolveActiveKey();
  }

  health() {
    try {
      const active = this.resolveActiveKey();
      return {
        ok: Boolean(active),
        providerType: this.providerType,
        source:
          this.env.NODE_ENV === "development"
            ? "development-env-file"
            : "runtime-env-file",
        sourceMode: safeFileMode(this.envPath)?.toString(8) || null,
        keyring: fs.existsSync(this.keyringPath),
        keyId: active?.keyId || null,
        fingerprint: active?.fingerprint || null,
        mutable: true,
      };
    } catch (error) {
      return {
        ok: false,
        providerType: this.providerType,
        error: error.message,
      };
    }
  }
}

class SecretFileKeyProvider {
  constructor({ env = process.env, filePath = null } = {}) {
    this.env = env;
    this.filePath = path.resolve(
      filePath || env.ATHENA_MASTER_KEY_FILE || "/run/secrets/athena_master_key"
    );
    this.providerType = "secret-file";
  }

  resolveActiveKey() {
    assertSecureFile(this.filePath);
    const material = normalizeKey(
      fs.readFileSync(this.filePath, "utf8"),
      "ATHENA_MASTER_KEY_FILE"
    );
    const ambient = normalizeKey(this.env[MASTER_KEY_ENV]);
    if (ambient && ambient !== material) {
      throw new EncryptionConfigError(
        "key_source_conflict: secret-file and process keys differ"
      );
    }
    return {
      keyId: keyIdFor(material),
      purpose: SERVER_DATA_PURPOSE,
      fingerprint: fingerprint(material),
      status: "active",
      providerType: this.providerType,
      material: Buffer.from(material, "hex"),
    };
  }

  resolveKey(keyId) {
    const active = this.resolveActiveKey();
    return active.keyId === keyId ? active : null;
  }

  health() {
    try {
      const active = this.resolveActiveKey();
      return {
        ok: true,
        providerType: this.providerType,
        source: "docker-secret-file",
        sourceMode: safeFileMode(this.filePath)?.toString(8),
        keyId: active.keyId,
        fingerprint: active.fingerprint,
        mutable: false,
      };
    } catch (error) {
      return {
        ok: false,
        providerType: this.providerType,
        error: error.message,
      };
    }
  }
}

class EnvironmentKeyProvider {
  constructor({ env = process.env } = {}) {
    this.env = env;
    this.providerType = "environment";
  }

  resolveActiveKey() {
    const material = normalizeKey(this.env[MASTER_KEY_ENV]);
    if (!material) return null;
    return {
      keyId: keyIdFor(material),
      purpose: SERVER_DATA_PURPOSE,
      fingerprint: fingerprint(material),
      status: "active",
      providerType: this.providerType,
      material: Buffer.from(material, "hex"),
    };
  }

  resolveKey(keyId) {
    const active = this.resolveActiveKey();
    return active?.keyId === keyId ? active : null;
  }

  health() {
    try {
      const active = this.resolveActiveKey();
      return {
        ok: Boolean(active),
        providerType: this.providerType,
        source: "process-environment",
        sourceMode: null,
        keyId: active?.keyId || null,
        fingerprint: active?.fingerprint || null,
        mutable: false,
      };
    } catch (error) {
      return {
        ok: false,
        providerType: this.providerType,
        error: error.message,
      };
    }
  }
}

function createKeyProvider({ env = process.env } = {}) {
  const configured = String(env.ATHENA_KEY_PROVIDER || "")
    .trim()
    .toLowerCase();
  if (!configured && env.NODE_ENV === "test") {
    return new EnvironmentKeyProvider({ env });
  }
  if (
    configured === "secret-file" ||
    (!configured && env.ATHENA_MASTER_KEY_FILE)
  ) {
    return new SecretFileKeyProvider({ env });
  }
  if (configured === "environment") return new EnvironmentKeyProvider({ env });
  if (!configured || configured === "env-file")
    return new EnvFileKeyProvider({ env });
  throw new EncryptionConfigError(
    `Unsupported ATHENA_KEY_PROVIDER: ${configured}`
  );
}

module.exports = {
  EnvironmentKeyProvider,
  EnvFileKeyProvider,
  KEYRING_VERSION,
  SERVER_DATA_PURPOSE,
  SecretFileKeyProvider,
  createKeyProvider,
  defaultEnvPath,
  fingerprint,
  keyIdFor,
  normalizeKey,
};
