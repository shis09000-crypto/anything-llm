const { MASTER_KEY_ENV } = require("./constants");
const { assertProductionTransportConfig, envFlag } = require("./transportSecurity");

const WEAK_SECRET_VALUES = new Set([
  "secret",
  "password",
  "changeme",
  "change-me",
  "my-random-string-for-seeding",
  "anythingllm",
  "jwt_secret",
  "jwt-secret",
]);

function present(value) {
  return String(value || "").trim();
}

function validateStrongSecret(name, value, minLength = 32) {
  const normalized = present(value);
  if (!normalized) return `${name} is required in production.`;
  if (normalized.length < minLength) {
    return `${name} must be at least ${minLength} characters in production.`;
  }
  if (WEAK_SECRET_VALUES.has(normalized.toLowerCase())) {
    return `${name} uses a known weak development value.`;
  }
  return null;
}

function validateMasterKey(env = process.env) {
  const value = present(env[MASTER_KEY_ENV]);
  if (!value) return `${MASTER_KEY_ENV} is required in production.`;
  if (!/^[a-fA-F0-9]+$/.test(value)) {
    return `${MASTER_KEY_ENV} must be a 64-character hex string.`;
  }
  if (value.length !== 64) return `${MASTER_KEY_ENV} must be exactly 32 bytes.`;
  if (/^(.)\1+$/.test(value)) return `${MASTER_KEY_ENV} is not random enough.`;
  return null;
}

function productionSecurityFindings(env = process.env) {
  if (env.NODE_ENV !== "production") return [];
  const findings = [];

  try {
    assertProductionTransportConfig(env);
  } catch (error) {
    findings.push(error.message);
  }

  const jwtFinding = validateStrongSecret("JWT_SECRET", env.JWT_SECRET);
  if (jwtFinding) findings.push(jwtFinding);

  const authTokenFinding = validateStrongSecret("AUTH_TOKEN", env.AUTH_TOKEN);
  if (authTokenFinding) findings.push(authTokenFinding);

  const masterKeyFinding = validateMasterKey(env);
  if (masterKeyFinding) findings.push(masterKeyFinding);

  if (envFlag(env.ATHENA_SIGNING_WARN_ONLY)) {
    findings.push("ATHENA_SIGNING_WARN_ONLY cannot be true in production.");
  }
  if (envFlag(env.VITE_CODEX_DEV_AUTH_BYPASS) || present(env.CODEX_DEV_AUTH_BYPASS_KEY)) {
    findings.push("Codex dev auth bypass configuration must not be present in production.");
  }
  if (envFlag(env.CRYPTO_CENTER_AUTH_BYPASS) || envFlag(env.VITE_CRYPTO_CENTER_AUTH_BYPASS)) {
    findings.push("Crypto Center auth bypass must not be enabled in production.");
  }

  return findings;
}

function assertProductionSecurityConfig(env = process.env) {
  const findings = productionSecurityFindings(env);
  if (!findings.length) return { production: env.NODE_ENV === "production" };
  throw new Error(
    `Unsafe production security configuration:\n- ${findings.join("\n- ")}`
  );
}

module.exports = {
  assertProductionSecurityConfig,
  productionSecurityFindings,
};
