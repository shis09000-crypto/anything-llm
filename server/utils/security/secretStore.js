const {
  decryptSecretIfNeeded,
  encryptSecret,
  isEncryptedSecret,
} = require("./encryption");

function saveSecret(value) {
  return encryptSecret(value);
}

function readSecret(value) {
  return decryptSecretIfNeeded(value);
}

function isSecretEncrypted(value) {
  return isEncryptedSecret(value);
}

module.exports = {
  saveSecret,
  readSecret,
  isSecretEncrypted,
};
