const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  EnvFileKeyProvider,
} = require("../../../utils/security/keyCustody/providers");
const {
  activateKey,
  clearRuntimeActiveKey,
  resetKeyProviderForTests,
  resolveActiveKey,
  resolveKey,
  setRuntimeActiveKey,
} = require("../../../utils/security/keyCustody");

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

describe("key custody env-file provider", () => {
  let directory;
  let envPath;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "athena-key-custody-"));
    envPath = path.join(directory, ".env");
  });

  afterEach(() => {
    resetKeyProviderForTests();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function writeEnv(value, mode = 0o600) {
    fs.writeFileSync(envPath, `ENCRYPTION_MASTER_KEY=${value}\n`, { mode });
    fs.chmodSync(envPath, mode);
  }

  it("resolves a secure authoritative env file", () => {
    writeEnv(KEY_A);
    const provider = new EnvFileKeyProvider({
      env: { NODE_ENV: "production" },
      envPath,
    });

    expect(provider.resolveActiveKey()).toMatchObject({
      purpose: "server-data-at-rest",
      providerType: "env-file",
      status: "active",
    });
    expect(provider.health()).toMatchObject({ ok: true, sourceMode: "600" });
  });

  it("rejects process and persisted source conflicts", () => {
    writeEnv(KEY_A);
    const provider = new EnvFileKeyProvider({
      env: { NODE_ENV: "production", ENCRYPTION_MASTER_KEY: KEY_B },
      envPath,
    });

    expect(() => provider.resolveActiveKey()).toThrow("key_source_conflict");
  });

  it("rejects group or world readable key files", () => {
    writeEnv(KEY_A, 0o644);
    const provider = new EnvFileKeyProvider({
      env: { NODE_ENV: "production" },
      envPath,
    });

    expect(() => provider.resolveActiveKey()).toThrow(
      "Key source permissions must be 0400 or 0600"
    );
  });

  it("bootstraps an empty local provider with mode 0600", () => {
    const env = { NODE_ENV: "production" };
    const provider = new EnvFileKeyProvider({ env, envPath });

    const descriptor = provider.bootstrapKey();

    expect(descriptor.material).toHaveLength(32);
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
    expect(env.ENCRYPTION_MASTER_KEY).toHaveLength(64);
  });

  it("keeps the previous key decrypt-only after activation", () => {
    writeEnv(KEY_A);
    const env = { NODE_ENV: "production", ENCRYPTION_MASTER_KEY: KEY_A };
    const provider = new EnvFileKeyProvider({ env, envPath });
    const previous = provider.resolveActiveKey();
    const pending = provider.generatePendingKey();

    expect(pending.status).toBe("pending");
    expect(provider.activateKey(pending.keyId).keyId).toBe(pending.keyId);
    expect(provider.resolveKey(previous.keyId)).toMatchObject({
      keyId: previous.keyId,
      status: "decrypt_only",
    });
    expect(fs.statSync(`${envPath}.keyring.json`).mode & 0o777).toBe(0o600);
  });

  it("uses a verified registry key as the in-memory runtime authority", () => {
    const providerActive = {
      keyId: "sdk_provider",
      purpose: "server-data-at-rest",
      material: Buffer.from(KEY_B, "hex"),
    };
    const registryActive = {
      keyId: "sdk_registry",
      purpose: "server-data-at-rest",
      material: Buffer.from(KEY_A, "hex"),
    };
    resetKeyProviderForTests({
      resolveActiveKey: () => providerActive,
      resolveKey: (keyId) =>
        keyId === registryActive.keyId ? registryActive : null,
    });

    expect(resolveActiveKey()).toBe(providerActive);
    setRuntimeActiveKey(resolveKey(registryActive.keyId));
    expect(resolveActiveKey()).toBe(registryActive);
    expect(resolveKey(registryActive.keyId)).toBe(registryActive);
    clearRuntimeActiveKey();
    expect(resolveActiveKey()).toBe(providerActive);
  });

  it("replaces the runtime authority when a rotation activates a key", () => {
    const providerActive = {
      keyId: "sdk_provider",
      purpose: "server-data-at-rest",
      material: Buffer.from(KEY_A, "hex"),
    };
    const rotated = {
      keyId: "sdk_rotated",
      purpose: "server-data-at-rest",
      material: Buffer.from(KEY_B, "hex"),
    };
    const provider = {
      activateKey: jest.fn(() => rotated),
      resolveActiveKey: jest.fn(() => providerActive),
      resolveKey: jest.fn((keyId) =>
        keyId === rotated.keyId ? rotated : providerActive
      ),
    };
    resetKeyProviderForTests(provider);
    setRuntimeActiveKey(providerActive);

    expect(activateKey(rotated.keyId)).toBe(rotated);
    expect(resolveActiveKey()).toBe(rotated);
    expect(provider.activateKey).toHaveBeenCalledWith(
      rotated.keyId,
      "server-data-at-rest"
    );
  });
});
