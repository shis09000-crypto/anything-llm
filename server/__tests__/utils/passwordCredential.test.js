const bcrypt = require("bcryptjs");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  ARGON2_POLICY,
  CREDENTIAL_TYPES,
  canUsePasswordCredential,
  hashPassword,
  passwordHashKind,
  passwordCredentialType,
  passwordPepper,
  resetPasswordCredentialForTests,
  verifyPassword,
} = require("../../utils/security/passwordCredential");

describe("password credential policy", () => {
  let temporaryDirectory;

  beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "athena-password-")
    );
    resetPasswordCredentialForTests();
  });

  afterEach(() => {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    resetPasswordCredentialForTests();
  });

  it("creates and verifies the governed Argon2id policy", async () => {
    const encoded = await hashPassword("correct horse battery staple", {});
    expect(passwordHashKind(encoded)).toBe("argon2id");
    expect(encoded).toContain(
      `m=${ARGON2_POLICY.memoryCost},t=${ARGON2_POLICY.timeCost},p=${ARGON2_POLICY.parallelism}`
    );
    await expect(
      verifyPassword("correct horse battery staple", encoded, {})
    ).resolves.toMatchObject({
      valid: true,
      kind: "argon2id",
      needsUpgrade: false,
    });
    await expect(verifyPassword("wrong", encoded, {})).resolves.toMatchObject({
      valid: false,
    });
  });

  it("accepts legacy bcrypt only long enough to request an upgrade", async () => {
    const encoded = await bcrypt.hash("legacy", 10);
    await expect(verifyPassword("legacy", encoded, {})).resolves.toEqual({
      valid: true,
      kind: "bcrypt",
      needsUpgrade: true,
    });
  });

  it("blocks explicit non-password and unknown legacy credentials", () => {
    expect(
      passwordCredentialType({
        credentialType: CREDENTIAL_TYPES.PASSKEY_ONLY,
        password: "$2b$10$ignored",
      })
    ).toBe(CREDENTIAL_TYPES.PASSKEY_ONLY);
    expect(
      canUsePasswordCredential({
        credentialType: CREDENTIAL_TYPES.LEGACY_UNKNOWN,
        password: "historical-value",
      })
    ).toBe(false);
    expect(passwordCredentialType({ password: "historical-value" })).toBe(
      CREDENTIAL_TYPES.LEGACY_UNKNOWN
    );
  });

  it("uses a protected external pepper file and migrates unpeppered hashes", async () => {
    const pepperPath = path.join(temporaryDirectory, "pepper");
    fs.writeFileSync(pepperPath, Buffer.alloc(32, 9), { mode: 0o600 });
    const env = { ATHENA_PASSWORD_PEPPER_FILE: pepperPath };
    expect(passwordPepper(env)).toEqual(Buffer.alloc(32, 9));

    const legacyArgon = await hashPassword("migrate-me", {});
    await expect(
      verifyPassword("migrate-me", legacyArgon, env)
    ).resolves.toMatchObject({
      valid: true,
      needsUpgrade: true,
    });
    const peppered = await hashPassword("migrate-me", env);
    await expect(
      verifyPassword("migrate-me", peppered, env)
    ).resolves.toMatchObject({
      valid: true,
      needsUpgrade: false,
    });
  });

  it("rejects group-readable pepper files", () => {
    const pepperPath = path.join(temporaryDirectory, "pepper");
    fs.writeFileSync(pepperPath, Buffer.alloc(32, 7), { mode: 0o644 });
    expect(() =>
      passwordPepper({ ATHENA_PASSWORD_PEPPER_FILE: pepperPath })
    ).toThrow("password_pepper_file_permissions_unsafe");
  });
});
