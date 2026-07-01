const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("document store encryption", () => {
  const originalKey = process.env.ENCRYPTION_MASTER_KEY;

  beforeEach(() => {
    jest.resetModules();
    process.env.ENCRYPTION_MASTER_KEY = TEST_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ENCRYPTION_MASTER_KEY;
    else process.env.ENCRYPTION_MASTER_KEY = originalKey;
    delete process.env.DOCUMENT_STORE_ENCRYPTION;
    delete process.env.DOCUMENT_STORE_ENCRYPTION_DISABLED;
  });

  it("encrypts document payloads without exposing source text", () => {
    const {
      decryptDocumentStorePayload,
      encryptDocumentStorePayload,
      isEncryptedDocumentStorePayload,
    } = require("../../utils/security/documentStoreEncryption");

    const payload = {
      title: "Private Doc",
      pageContent: "very sensitive document text",
    };
    const encrypted = encryptDocumentStorePayload(payload, {
      domain: "source-document",
    });

    expect(isEncryptedDocumentStorePayload(encrypted)).toBe(true);
    expect(JSON.stringify(encrypted)).not.toContain("very sensitive");
    expect(
      decryptDocumentStorePayload(encrypted, { domain: "source-document" })
    ).toEqual(payload);
  });

  it("keeps legacy plaintext payloads readable", () => {
    const { decryptDocumentStorePayload } = require("../../utils/security/documentStoreEncryption");
    const legacy = { title: "Legacy", pageContent: "plain" };

    expect(
      decryptDocumentStorePayload(legacy, { domain: "source-document" })
    ).toEqual(legacy);
  });

  it("can disable encryption for compatibility", () => {
    process.env.DOCUMENT_STORE_ENCRYPTION = "false";
    const {
      encryptDocumentStorePayload,
      isEncryptedDocumentStorePayload,
    } = require("../../utils/security/documentStoreEncryption");
    const payload = { pageContent: "plain local document" };

    const stored = encryptDocumentStorePayload(payload, {
      domain: "source-document",
    });

    expect(isEncryptedDocumentStorePayload(stored)).toBe(false);
    expect(stored).toEqual(payload);
  });
});
