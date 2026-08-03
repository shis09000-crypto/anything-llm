const crypto = require("crypto");

function browserEgressKeyError(code) {
  return Object.assign(new Error(code), { code, httpStatus: 400 });
}

function safeBrowserNodePublicKey(value) {
  const pem = String(value || "");
  if (
    pem.length < 400 ||
    pem.length > 8_192 ||
    !pem.includes("BEGIN PUBLIC KEY")
  ) {
    throw browserEgressKeyError("browser_egress_node_key_invalid");
  }
  let key;
  try {
    key = crypto.createPublicKey(pem);
  } catch {
    throw browserEgressKeyError("browser_egress_node_key_invalid");
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw browserEgressKeyError("browser_egress_node_key_invalid");
  }
  const bits = Number(key.asymmetricKeyDetails?.modulusLength || 0);
  if (bits < 3072) {
    throw browserEgressKeyError("browser_egress_node_key_too_weak");
  }
  return key;
}

function sealBrowserEgressConfig(config, publicKey) {
  const targetKey =
    publicKey?.type === "public"
      ? publicKey
      : safeBrowserNodePublicKey(publicKey);
  const plaintext = Buffer.from(JSON.stringify(config), "utf8");
  const envelopeKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", envelopeKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const encryptedKey = crypto.publicEncrypt(
    {
      key: targetKey,
      oaepHash: "sha256",
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    },
    envelopeKey
  );
  return {
    version: "athena-browser-egress-sealed:v1",
    algorithm: "RSA-OAEP-3072-SHA256+A256GCM",
    encryptedKey: encryptedKey.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

module.exports = {
  safeBrowserNodePublicKey,
  sealBrowserEgressConfig,
};
