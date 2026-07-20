const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const WRONG_KEY =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

describe("encryption diagnostics", () => {
  const originalKey = process.env.ENCRYPTION_MASTER_KEY;

  beforeEach(() => {
    jest.resetModules();
    process.env.ENCRYPTION_MASTER_KEY = TEST_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ENCRYPTION_MASTER_KEY;
    else process.env.ENCRYPTION_MASTER_KEY = originalKey;
  });

  it("records a redacted document-store blocker without swallowing the error", () => {
    const {
      encryptDocumentStorePayload,
      decryptDocumentStorePayload,
    } = require("../../../utils/security/documentStoreEncryption");
    const encrypted = encryptDocumentStorePayload(
      { pageContent: "private biology notes" },
      { domain: "source-document" }
    );
    const encryptedText = encrypted.encryptedPayload;
    const privatePath = "/Users/example/private/cell-notes.json";

    process.env.ENCRYPTION_MASTER_KEY = WRONG_KEY;

    expect(() =>
      decryptDocumentStorePayload(encrypted, {
        domain: "source-document",
        resource: privatePath,
      })
    ).toThrow("ENCRYPTION_MASTER_KEY is required.");

    const {
      encryptionDiagnosticsSnapshot,
    } = require("../../../utils/security/encryptionDiagnostics");
    const snapshot = encryptionDiagnosticsSnapshot();

    expect(snapshot.totalBlocked).toBe(1);
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]).toMatchObject({
      kind: "system-diagnostic",
      subsystem: "encryption",
      severity: "blocker",
      operation: "decrypt-document-store",
      domain: "source-document",
      errorCode: "encryption_config_error",
      blocked: true,
    });
    expect(snapshot.events[0].resourceFingerprint).toMatch(/^[a-f0-9]{12}$/);
    expect(snapshot.events[0].payloadFingerprint).toMatch(/^[a-f0-9]{12}$/);
    expect(snapshot.keyState).toMatchObject({
      configured: true,
      validFormat: true,
    });

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(privatePath);
    expect(serialized).not.toContain("cell-notes.json");
    expect(serialized).not.toContain("private biology notes");
    expect(serialized).not.toContain(encryptedText);
    expect(serialized).not.toContain(WRONG_KEY);
  });

  it("records malformed ciphertext as a format blocker", () => {
    const { decryptSecret } = require("../../../utils/security/encryption");

    expect(() =>
      decryptSecret("enc:v1:only-two-parts", {
        operation: "read-connector-secret",
        domain: "connector",
      })
    ).toThrow("Encrypted secret format is invalid.");

    const {
      encryptionDiagnosticsSnapshot,
    } = require("../../../utils/security/encryptionDiagnostics");
    expect(encryptionDiagnosticsSnapshot().events[0]).toMatchObject({
      operation: "read-connector-secret",
      domain: "connector",
      errorCode: "encryption_format_error",
    });
  });
});
