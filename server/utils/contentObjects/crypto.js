// Compatibility facade. Cryptographic primitives are owned by Key Custody so
// content-object callers cannot grow a parallel key-management boundary.
module.exports = require("../security/keyCustody/contentObjectCrypto");
