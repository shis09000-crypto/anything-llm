const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const {
  CLIENT_VERSION,
  SEALED_VERSION,
  decryptEnvelope,
  privateAddressLiteral,
} = require("../browser-egress-runtime.cjs");

function seal(config, publicKey) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(config))),
    cipher.final(),
  ]);
  return {
    version: SEALED_VERSION,
    encryptedKey: crypto
      .publicEncrypt(
        {
          key: publicKey,
          oaepHash: "sha256",
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        },
        key
      )
      .toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

test("device envelope decrypts only with the bound startup key", () => {
  const recipient = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 });
  const other = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 });
  const config = {
    version: CLIENT_VERSION,
    grantId: "grant-12345678",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    endpoint: {
      host: "browser-egress.example.test",
      port: 8443,
      serverName: "www.example.test",
    },
    transport: {
      uuid: crypto.randomUUID(),
      flow: "xtls-rprx-vision",
      realityPublicKey: "public-key",
      realityShortId: "00112233",
    },
  };
  const envelope = seal(config, recipient.publicKey);
  assert.deepEqual(decryptEnvelope(envelope, recipient.privateKey), config);
  assert.throws(
    () => decryptEnvelope(envelope, other.privateKey),
    /oaep decoding error|decrypt/i
  );
});

test("expired grants and tampered ciphertext fail closed", () => {
  const recipient = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 });
  const expired = seal(
    {
      version: CLIENT_VERSION,
      grantId: "grant-12345678",
      expiresAt: new Date(Date.now() - 1).toISOString(),
      endpoint: { host: "egress.test", port: 8443, serverName: "s.test" },
      transport: {
        uuid: crypto.randomUUID(),
        realityPublicKey: "pk",
        realityShortId: "11",
      },
    },
    recipient.publicKey
  );
  assert.throws(
    () => decryptEnvelope(expired, recipient.privateKey),
    /browser_egress_grant_expired/
  );
  const valid = seal(
    {
      version: CLIENT_VERSION,
      grantId: "grant-12345678",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      endpoint: { host: "egress.test", port: 8443, serverName: "s.test" },
      transport: {
        uuid: crypto.randomUUID(),
        realityPublicKey: "pk",
        realityShortId: "11",
      },
    },
    recipient.publicKey
  );
  valid.ciphertext = `${valid.ciphertext.slice(0, -2)}AA`;
  assert.throws(() => decryptEnvelope(valid, recipient.privateKey));
});

test("managed Chrome bridge rejects local and reserved IP literals", () => {
  for (const address of [
    "localhost",
    "127.0.0.1",
    "10.1.2.3",
    "172.20.1.4",
    "192.168.1.8",
    "169.254.169.254",
    "224.0.0.1",
    "::1",
    "fe80::1",
    "fd00::1",
  ])
    assert.equal(privateAddressLiteral(address), true, address);
  assert.equal(privateAddressLiteral("8.8.8.8"), false);
  assert.equal(privateAddressLiteral("accounts.google.com"), false);
});
