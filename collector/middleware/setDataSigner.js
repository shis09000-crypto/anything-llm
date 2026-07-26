const { EncryptionWorker } = require("../utils/EncryptionWorker");
const { CommunicationKey } = require("../utils/comKey");

/**
 * Express Response Object interface with defined encryptionWorker attached to locals property.
 * @typedef {import("express").Response & import("express").Response['locals'] & {encryptionWorker: EncryptionWorker} } ResponseWithSigner
 */

// You can use this middleware to assign the EncryptionWorker to the response locals
// property so that if can be used to encrypt/decrypt arbitrary data via response object.
// eg: Encrypting API keys in chunk sources.

// The payload key is provisioned once by the server into the read-only comkey
// mount. It is never transported in a request header. EncryptionWorker derives
// an AEAD sub-key with HKDF and retains the root only for legacy CBC reads.

/**
 *
 * @param {import("express").Request} request
 * @param {import("express").Response} response
 * @param {import("express").NextFunction} next
 */
function setDataSigner(request, response, next) {
  try {
    const payloadKey = new CommunicationKey().payloadKey();
    response.locals.encryptionWorker = new EncryptionWorker(payloadKey);
    next();
  } catch (error) {
    console.error("Collector payload keyring is unavailable.", error.message);
    return response.status(503).json({
      success: false,
      error: "collector_payload_key_unavailable",
    });
  }
}

module.exports = {
  setDataSigner,
};
