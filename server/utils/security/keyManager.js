const { MASTER_KEY_ENV } = require("./constants");
const { EncryptionConfigError } = require("./errors");

function getMasterKey() {
  const value = process.env[MASTER_KEY_ENV];
  if (!value) {
    throw new EncryptionConfigError(`${MASTER_KEY_ENV} is required.`);
  }

  const normalized = String(value).trim();
  if (!/^[a-fA-F0-9]+$/.test(normalized)) {
    throw new EncryptionConfigError(`${MASTER_KEY_ENV} must be a hex string.`);
  }

  if (normalized.length !== 64) {
    throw new EncryptionConfigError(`${MASTER_KEY_ENV} must be 32 bytes.`);
  }

  return Buffer.from(normalized, "hex");
}

module.exports = {
  getMasterKey,
};
