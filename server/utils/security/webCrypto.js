function hasUsableWebCrypto(cryptoImpl = globalThis.crypto) {
  return !!(
    cryptoImpl?.subtle &&
    typeof cryptoImpl.getRandomValues === "function"
  );
}

function ensureWebCrypto() {
  if (hasUsableWebCrypto()) return true;

  const { webcrypto } = require("crypto");
  if (!hasUsableWebCrypto(webcrypto)) return false;

  globalThis.crypto = webcrypto;
  return true;
}

module.exports = {
  ensureWebCrypto,
  hasUsableWebCrypto,
};
