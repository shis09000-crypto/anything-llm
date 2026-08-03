const crypto = require("crypto");
const {
  safeBrowserNodePublicKey,
  sealBrowserEgressConfig,
} = require("../../utils/security/browserEgressEnvelope");

describe("browser egress device envelope", () => {
  test("seals a config to a validated 3072-bit device key", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 3072,
      publicExponent: 0x10001,
    });
    const publicPem = publicKey.export({ type: "spki", format: "pem" });
    const target = safeBrowserNodePublicKey(publicPem);
    const config = { grantId: "grant_test", endpoint: { host: "example.com" } };
    const sealed = sealBrowserEgressConfig(config, target);
    const envelopeKey = crypto.privateDecrypt(
      {
        key: privateKey,
        oaepHash: "sha256",
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      },
      Buffer.from(sealed.encryptedKey, "base64")
    );
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      envelopeKey,
      Buffer.from(sealed.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]);

    expect(JSON.parse(plaintext.toString("utf8"))).toEqual(config);
    expect(sealed).toMatchObject({
      version: "athena-browser-egress-sealed:v1",
      algorithm: "RSA-OAEP-3072-SHA256+A256GCM",
    });
  });

  test("rejects keys below the configured security floor", () => {
    const { publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicExponent: 0x10001,
    });
    expect(() =>
      safeBrowserNodePublicKey(
        publicKey.export({ type: "spki", format: "pem" })
      )
    ).toThrow("browser_egress_node_key_too_weak");
  });
});
