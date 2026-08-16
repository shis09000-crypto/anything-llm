const {
  decryptSecretIfNeededAsync,
  decryptSecretIfNeeded,
  encryptSecretAsync,
  encryptSecret,
  isEncryptedSecret,
} = require("./encryption");

function saveSecret(value) {
  return encryptSecret(value);
}

function readSecret(value) {
  return decryptSecretIfNeeded(value);
}

async function saveSecretAsync(value, context = {}) {
  return encryptSecretAsync(value, context);
}

async function readSecretAsync(value, context = {}) {
  return decryptSecretIfNeededAsync(value, context);
}

function isSecretEncrypted(value) {
  return isEncryptedSecret(value);
}

module.exports = {
  saveSecret,
  saveSecretAsync,
  readSecret,
  readSecretAsync,
  isSecretEncrypted,
};
