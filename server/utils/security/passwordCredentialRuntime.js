const passwordCredential = require("./passwordCredential");

const SUPPORTED_PASSWORD_HASH_KINDS = new Set(["argon2id", "bcrypt"]);

function legacyPasswordCredentialCheck(credential = {}) {
  return SUPPORTED_PASSWORD_HASH_KINDS.has(
    passwordCredential.passwordHashKind(credential?.password)
  );
}

function passwordCredentialRuntime() {
  const governedCheck = passwordCredential.canUsePasswordCredential;
  return {
    ...passwordCredential,
    canUsePasswordCredential:
      typeof governedCheck === "function"
        ? governedCheck
        : legacyPasswordCredentialCheck,
    compatibilityFallback: typeof governedCheck !== "function",
  };
}

function assertPasswordCredentialRuntime() {
  const runtime = passwordCredentialRuntime();
  for (const dependency of [
    "canUsePasswordCredential",
    "dummyPasswordCompare",
    "passwordHashKind",
    "verifyPassword",
  ]) {
    if (typeof runtime[dependency] !== "function") {
      const error = new Error(
        `password_credential_runtime_contract_missing:${dependency}`
      );
      error.code = "PASSWORD_CREDENTIAL_RUNTIME_CONTRACT_MISSING";
      throw error;
    }
  }
  return runtime;
}

module.exports = {
  assertPasswordCredentialRuntime,
  legacyPasswordCredentialCheck,
  passwordCredentialRuntime,
};
