const crypto = require("crypto");

const AEAD_VERSION = "v2";
const AEAD_ALGORITHM = "aes-256-gcm";
const AEAD_AAD = Buffer.from("athena:collector:source-payload:v2", "utf8");
const HKDF_SALT = Buffer.from("athena:collector:keyring:v2", "utf8");
const HKDF_INFO = Buffer.from("source-payload-encryption", "utf8");
const MAX_ENCRYPTED_PAYLOAD_BYTES = 4 * 1024 * 1024;

// Receives the persisted 32-byte Collector keyring root. It derives the v2
// AEAD key with HKDF. The root can read legacy CBC envelopes only when an
// operator explicitly opens the bounded migration compatibility window.
class EncryptionWorker {
  constructor(presetKeyBase64 = "") {
    this.legacyKey = Buffer.from(presetKeyBase64, "base64");
    if (
      !presetKeyBase64 ||
      this.legacyKey.length !== 32 ||
      this.legacyKey.toString("base64") !== presetKeyBase64
    )
      throw new Error("collector_payload_key_invalid");
    this.key = Buffer.from(
      crypto.hkdfSync("sha256", this.legacyKey, HKDF_SALT, HKDF_INFO, 32)
    );
    this.algorithm = AEAD_ALGORITHM;
    this.separator = ":";
  }

  log(text, ...args) {
    console.log(`\x1b[36m[EncryptionWorker]\x1b[0m ${text}`, ...args);
  }

  /**
   * Give a chunk source, parse its payload query param and expand that object back into the URL
   * as additional query params
   * @param {string} chunkSource
   * @returns {URL} Javascript URL object with query params decrypted from payload query param.
   */
  expandPayload(chunkSource = "") {
    try {
      const url = new URL(chunkSource);
      if (!url.searchParams.has("payload")) return url;

      const decryptedPayload = this.decrypt(url.searchParams.get("payload"));
      const encodedParams = JSON.parse(decryptedPayload);
      url.searchParams.delete("payload"); // remove payload prop

      // Add all query params needed to replay as query params
      Object.entries(encodedParams).forEach(([key, value]) =>
        url.searchParams.append(key, value)
      );
      return url;
    } catch (e) {
      console.error(e);
    }
    return new URL(chunkSource);
  }

  encrypt(plainTextString = null) {
    try {
      if (!plainTextString)
        throw new Error("Empty string is not valid for this method.");
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);
      cipher.setAAD(AEAD_AAD);
      const encrypted = Buffer.concat([
        cipher.update(plainTextString, "utf8"),
        cipher.final(),
      ]);
      const authenticationTag = cipher.getAuthTag();
      return [
        AEAD_VERSION,
        iv.toString("base64url"),
        encrypted.toString("base64url"),
        authenticationTag.toString("base64url"),
      ].join(this.separator);
    } catch (e) {
      this.log(e.message);
      return null;
    }
  }

  decrypt(encryptedString) {
    try {
      if (typeof encryptedString !== "string")
        throw new Error("Encrypted payload must be a string.");
      if (
        Buffer.byteLength(encryptedString, "utf8") > MAX_ENCRYPTED_PAYLOAD_BYTES
      )
        throw new Error("Encrypted payload exceeds the maximum size.");
      if (encryptedString.startsWith(`${AEAD_VERSION}${this.separator}`))
        return this.#decryptAead(encryptedString);
      if (process.env.ATHENA_COLLECTOR_LEGACY_PAYLOAD_DECRYPT !== "true")
        throw new Error("Legacy payload decryption is disabled.");
      return this.#decryptLegacyCbc(encryptedString);
    } catch (e) {
      this.log(e.message);
      return null;
    }
  }

  #decryptAead(encryptedString) {
    const [version, encodedIv, encodedCiphertext, encodedTag, ...remainder] =
      encryptedString.split(this.separator);
    if (
      version !== AEAD_VERSION ||
      !encodedIv ||
      !encodedCiphertext ||
      !encodedTag ||
      remainder.length
    )
      throw new Error("Invalid authenticated payload envelope.");
    const iv = Buffer.from(encodedIv, "base64url");
    const ciphertext = Buffer.from(encodedCiphertext, "base64url");
    const authenticationTag = Buffer.from(encodedTag, "base64url");
    if (iv.length !== 12 || authenticationTag.length !== 16)
      throw new Error("Invalid authenticated payload parameters.");
    const decipher = crypto.createDecipheriv(this.algorithm, this.key, iv);
    decipher.setAAD(AEAD_AAD);
    decipher.setAuthTag(authenticationTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  }

  #decryptLegacyCbc(encryptedString) {
    const [encrypted, iv, ...remainder] = encryptedString.split(this.separator);
    if (
      remainder.length ||
      !/^[a-f0-9]+$/i.test(encrypted || "") ||
      encrypted.length % 2 !== 0 ||
      !/^[a-f0-9]{32}$/i.test(iv || "")
    )
      throw new Error("Invalid legacy payload envelope.");
    const decipher = crypto.createDecipheriv(
      "aes-256-cbc",
      this.legacyKey,
      Buffer.from(iv, "hex")
    );
    return decipher.update(encrypted, "hex", "utf8") + decipher.final("utf8");
  }
}

module.exports = { EncryptionWorker };
