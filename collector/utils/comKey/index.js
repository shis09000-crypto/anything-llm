const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { storagePath } = require("../environment");
const keyPath = storagePath("comkey");

class CommunicationKey {
  #pubKeyName = "ipc-pub.pem";
  #payloadKeyName = "ipc-payload.key";
  #storageLoc = keyPath;

  constructor() {}

  log(text, ...args) {
    console.log(`\x1b[36m[CommunicationKeyVerify]\x1b[0m ${text}`, ...args);
  }

  #readPublicKey() {
    return fs.readFileSync(path.resolve(this.#storageLoc, this.#pubKeyName));
  }

  payloadKey() {
    const encoded = fs
      .readFileSync(
        path.resolve(this.#storageLoc, this.#payloadKeyName),
        "utf8"
      )
      .trim();
    const decoded = Buffer.from(encoded, "base64");
    if (
      !encoded ||
      decoded.length !== 32 ||
      decoded.toString("base64") !== encoded
    )
      throw new Error("collector_payload_key_invalid");
    return encoded;
  }

  // Given a signed payload from private key from /app/server/ this signature should
  // decode to match the textData provided. This class does verification only in collector.
  // Note: The textData is typically the JSON stringified body sent to the document processor API.
  verify(signature = "", textData = "") {
    try {
      let data = textData;
      if (typeof textData !== "string") data = JSON.stringify(data);
      return crypto.verify(
        "RSA-SHA256",
        Buffer.from(data),
        this.#readPublicKey(),
        Buffer.from(signature, "hex")
      );
    } catch {}
    return false;
  }

  verifyRequest({
    signature = "",
    method = "POST",
    requestPath = "/",
    timestamp = "",
    nonce = "",
    bodySha256 = "",
    body = "",
    computedBodySha256 = null,
    now = Date.now(),
    maxClockSkewMs = 5 * 60_000,
  } = {}) {
    if (!/^\d{13}$/.test(timestamp))
      return { ok: false, reason: "invalid_timestamp" };
    const timestampNumber = Number(timestamp);
    if (
      !Number.isSafeInteger(timestampNumber) ||
      Math.abs(now - timestampNumber) > maxClockSkewMs
    )
      return { ok: false, reason: "expired_timestamp" };
    if (!/^[A-Za-z0-9_-]{22,86}$/.test(nonce))
      return { ok: false, reason: "invalid_nonce" };
    if (!/^[a-f0-9]{64}$/.test(bodySha256))
      return { ok: false, reason: "invalid_body_digest" };

    let computedDigest = computedBodySha256;
    if (!computedDigest) {
      const bodyBuffer = Buffer.isBuffer(body)
        ? body
        : Buffer.from(
            typeof body === "string" ? body : JSON.stringify(body ?? ""),
            "utf8"
          );
      computedDigest = crypto
        .createHash("sha256")
        .update(bodyBuffer)
        .digest("hex");
    }
    if (!/^[a-f0-9]{64}$/.test(computedDigest))
      return { ok: false, reason: "invalid_computed_body_digest" };
    if (
      !crypto.timingSafeEqual(
        Buffer.from(computedDigest, "hex"),
        Buffer.from(bodySha256, "hex")
      )
    )
      return { ok: false, reason: "body_digest_mismatch" };

    const canonical = [
      "ATHENA-COLLECTOR-IPC-V2",
      String(method).toUpperCase(),
      requestPath,
      timestamp,
      nonce,
      bodySha256,
    ].join("\n");
    if (!this.verify(signature, canonical))
      return { ok: false, reason: "invalid_signature" };
    return { ok: true, timestamp: timestampNumber, nonce };
  }
}

module.exports = { CommunicationKey };
