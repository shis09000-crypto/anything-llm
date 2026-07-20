const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const { Algorithm, Version, hash, verify } = require("@node-rs/argon2");

const ARGON2_POLICY = Object.freeze({
  algorithm: Algorithm.Argon2id,
  version: Version.V0x13,
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
});

function passwordPepper(env = process.env) {
  const configured = String(env.ATHENA_PASSWORD_PEPPER_FILE || "").trim();
  if (!configured) return null;
  const filePath = path.resolve(configured);
  const stat = fs.statSync(filePath);
  if ((stat.mode & 0o077) !== 0) {
    const error = new Error("password_pepper_file_permissions_unsafe");
    error.code = "PASSWORD_PEPPER_FILE_PERMISSIONS_UNSAFE";
    throw error;
  }
  const value = fs.readFileSync(filePath);
  if (value.length < 32) {
    const error = new Error("password_pepper_too_short");
    error.code = "PASSWORD_PEPPER_TOO_SHORT";
    throw error;
  }
  return value;
}

function argonOptions(env = process.env) {
  const secret = passwordPepper(env);
  return {
    ...ARGON2_POLICY,
    ...(secret ? { secret } : {}),
  };
}

function passwordHashKind(encoded = "") {
  const value = String(encoded || "");
  if (value.startsWith("$argon2id$")) return "argon2id";
  if (/^\$2[aby]\$/.test(value)) return "bcrypt";
  return "unknown";
}

function argonHashMatchesPolicy(encoded = "") {
  const value = String(encoded || "");
  return (
    value.startsWith("$argon2id$v=19$") &&
    value.includes(
      `m=${ARGON2_POLICY.memoryCost},t=${ARGON2_POLICY.timeCost},p=${ARGON2_POLICY.parallelism}`
    )
  );
}

async function hashPassword(password, env = process.env) {
  return hash(Buffer.from(String(password || ""), "utf8"), argonOptions(env));
}

async function verifyPassword(password, encoded, env = process.env) {
  const kind = passwordHashKind(encoded);
  try {
    if (kind === "argon2id") {
      const secret = passwordPepper(env);
      let valid = await verify(
        String(encoded),
        Buffer.from(String(password || ""), "utf8"),
        secret ? { secret } : undefined
      );
      let missingPepper = false;
      if (!valid && secret) {
        valid = await verify(
          String(encoded),
          Buffer.from(String(password || ""), "utf8")
        );
        missingPepper = valid;
      }
      return {
        valid,
        kind,
        needsUpgrade:
          valid && (missingPepper || !argonHashMatchesPolicy(encoded)),
      };
    }
    if (kind === "bcrypt") {
      const valid = await bcrypt.compare(String(password || ""), encoded);
      return { valid, kind, needsUpgrade: valid };
    }
  } catch {
    return { valid: false, kind, needsUpgrade: false };
  }
  return { valid: false, kind, needsUpgrade: false };
}

let dummyHashPromise = null;

async function dummyPasswordCompare(password = "", env = process.env) {
  if (!dummyHashPromise)
    dummyHashPromise = hashPassword(
      "athena-login-dummy-password-never-valid",
      env
    );
  const encoded = await dummyHashPromise;
  const result = await verifyPassword(password, encoded, env);
  return result.valid;
}

function resetPasswordCredentialForTests() {
  dummyHashPromise = null;
}

module.exports = {
  ARGON2_POLICY,
  argonHashMatchesPolicy,
  argonOptions,
  dummyPasswordCompare,
  hashPassword,
  passwordHashKind,
  passwordPepper,
  resetPasswordCredentialForTests,
  verifyPassword,
};
