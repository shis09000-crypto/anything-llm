const { MASTER_KEY_ENV } = require("./constants");
const { EncryptionConfigError } = require("./errors");
const { resolveActiveKey, resolveKey } = require("./keyCustody");

function getMasterKeyDescriptor(keyId = null) {
  let descriptor;
  try {
    descriptor = keyId ? resolveKey(keyId) : resolveActiveKey();
  } catch (error) {
    if (error?.name === "EncryptionConfigError") throw error;
    throw new EncryptionConfigError(
      error?.message || `${MASTER_KEY_ENV} is invalid.`
    );
  }
  if (!descriptor?.material) {
    throw new EncryptionConfigError(`${MASTER_KEY_ENV} is required.`);
  }
  return descriptor;
}

function getMasterKey(keyId = null) {
  return getMasterKeyDescriptor(keyId).material;
}

module.exports = {
  getMasterKey,
  getMasterKeyDescriptor,
};
