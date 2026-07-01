const mockPrisma = {
  $executeRaw: jest.fn(),
  $queryRaw: jest.fn(),
};

jest.mock("../../utils/prisma", () => mockPrisma);

describe("VaultItem", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  function encryptedPayload(overrides = {}) {
    return {
      cryptoVersion: "athena-vault-item:v1",
      algorithm: "AES-GCM-256+AES-KW",
      keyId: "vmk:1:v1",
      wrappedItemKey: "wrapped",
      iv: "iv",
      ciphertext: "ciphertext",
      ...overrides,
    };
  }

  it("rejects plaintext or incomplete vault payloads", () => {
    const { VaultItem } = require("../../models/vaultItem");

    expect(() => VaultItem.normalizeEncryptedPayload("secret")).toThrow(
      "vault_encrypted_payload_required"
    );
    expect(() =>
      VaultItem.normalizeEncryptedPayload(encryptedPayload({ ciphertext: "" }))
    ).toThrow("vault_encrypted_payload_missing_ciphertext");
  });

  it("lists vault metadata without encrypted payloads", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        itemId: "vlt_1",
        itemType: "password",
        label: "Example",
        keyId: "vmk:1:v1",
        cryptoVersion: "athena-vault-item:v1",
        metadataJson: JSON.stringify({ origin: "test" }),
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const { VaultItem } = require("../../models/vaultItem");
    const items = await VaultItem.list({ userId: 1 });

    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(
      expect.objectContaining({
        itemId: "vlt_1",
        itemType: "password",
        label: "Example",
        metadata: { origin: "test" },
      })
    );
    expect(items[0].encryptedPayload).toBeUndefined();
  });

  it("stores structured encrypted payloads and returns encrypted detail", async () => {
    const payload = encryptedPayload();
    mockPrisma.$executeRaw.mockResolvedValue(1);
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        itemId: "vlt_1",
        itemType: "api_key",
        label: "Provider",
        keyId: payload.keyId,
        cryptoVersion: payload.cryptoVersion,
        encryptedPayload: JSON.stringify(payload),
        metadataJson: "{}",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const { VaultItem } = require("../../models/vaultItem");
    const item = await VaultItem.createOrUpdate({
      userId: 1,
      itemId: "vlt_1",
      itemType: "api_key",
      label: "Provider",
      encryptedPayload: payload,
    });

    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(item.encryptedPayload).toEqual(payload);
    expect(JSON.stringify(item)).not.toContain("plain-secret");
  });
});
