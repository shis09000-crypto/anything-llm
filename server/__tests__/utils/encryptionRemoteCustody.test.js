/* global jest, describe, beforeEach, test, expect */

const mockRemoteKeyCustodyEnabled = jest.fn();
const mockWrapMaterial = jest.fn();
const mockUnwrapMaterial = jest.fn();

jest.mock("../../utils/security/keyCustody/remoteClient", () => ({
  remoteKeyCustodyEnabled: mockRemoteKeyCustodyEnabled,
  wrapMaterial: mockWrapMaterial,
  unwrapMaterial: mockUnwrapMaterial,
}));

const {
  decryptSecretAsync,
  encryptSecretAsync,
} = require("../../utils/security/encryption");
const {
  readSecretAsync,
  saveSecretAsync,
} = require("../../utils/security/secretStore");

describe("remote Key Custody application envelopes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRemoteKeyCustodyEnabled.mockReturnValue(true);
  });

  test("wraps new application material through the remote capability", async () => {
    mockWrapMaterial.mockResolvedValue("enc:v2:remote:AA:AA:AA:AA");
    await expect(
      encryptSecretAsync("conversation-key", {
        purpose: "chat-conversation-key",
        domain: "chat-history",
        resource: "ck_1",
      })
    ).resolves.toBe("enc:v2:remote:AA:AA:AA:AA");
    expect(mockWrapMaterial).toHaveBeenCalledWith(
      "conversation-key",
      expect.objectContaining({
        purpose: "chat-conversation-key",
        domain: "chat-history",
        resource: "ck_1",
      })
    );
  });

  test("derives the stored purpose before remote legacy-compatible unwrap", async () => {
    const purpose = Buffer.from("secret-store", "utf8").toString("base64url");
    const wrapped = `enc:v2:key-1:${purpose}:AA:AA:AA`;
    mockUnwrapMaterial.mockResolvedValue("plain");
    await expect(decryptSecretAsync(wrapped)).resolves.toBe("plain");
    expect(mockUnwrapMaterial).toHaveBeenCalledWith(
      wrapped,
      expect.objectContaining({
        purpose: "secret-store",
        domain: "secret-store",
      })
    );
  });

  test("exposes remote-capable secret store helpers for identity runtimes", async () => {
    mockWrapMaterial.mockResolvedValue("enc:v2:remote:AA:AA:AA:AA");
    await expect(
      saveSecretAsync("opaque-setup", {
        purpose: "secret-store",
        domain: "authentication",
      })
    ).resolves.toBe("enc:v2:remote:AA:AA:AA:AA");

    const purpose = Buffer.from("secret-store", "utf8").toString("base64url");
    const wrapped = `enc:v2:key-1:${purpose}:AA:AA:AA`;
    mockUnwrapMaterial.mockResolvedValue("opaque-setup");
    await expect(
      readSecretAsync(wrapped, {
        purpose: "secret-store",
        domain: "authentication",
      })
    ).resolves.toBe("opaque-setup");
  });
});
