const {
  isSecretEncrypted,
  readSecret,
  saveSecret,
} = require("../../utils/security");

const SecretStoreProvider = {
  adapterName: "environment-master-key-secret-store",
  providerType: "secret-store",

  capabilities() {
    return {
      seal: true,
      reveal: true,
      revealPlaintextByDefault: false,
      auditRequired: true,
      adapterTargets: {
        externalKms: "reserved",
        vaultBackend: "reserved",
      },
    };
  },

  seal(value = null) {
    if (value === null || value === undefined || value === "") return null;
    return saveSecret(String(value));
  },

  envelope(value = null) {
    return {
      hasValue: Boolean(value),
      encrypted: Boolean(value) && isSecretEncrypted(value),
      provider: this.adapterName,
    };
  },

  reveal(value = null, { allowPlaintext = false } = {}) {
    if (!allowPlaintext) {
      const error = new Error("secret_reveal_requires_explicit_allow");
      error.code = "SECRET_REVEAL_REQUIRES_EXPLICIT_ALLOW";
      throw error;
    }
    return readSecret(value);
  },

  summary() {
    return {
      adapterName: this.adapterName,
      providerType: this.providerType,
      capabilities: this.capabilities(),
    };
  },
};

module.exports = { SecretStoreProvider };
