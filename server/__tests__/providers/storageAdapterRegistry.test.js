const path = require("path");

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR || path.resolve(__dirname, "../../storage");

const {
  StorageAdapterRegistry,
} = require("../../providers/storage/storageAdapterRegistry");

describe("StorageAdapterRegistry", () => {
  test("exposes active file/vector/secret adapters and reserved future adapters", () => {
    const summary = StorageAdapterRegistry.summary();

    expect(summary.active).toHaveProperty("file");
    expect(summary.active).toHaveProperty("vector");
    expect(summary.active).toHaveProperty("secret");
    expect(summary.reserved).toMatchObject({
      postgres: { status: "reserved" },
      objectStorage: { status: "reserved" },
      redis: { status: "reserved" },
    });
  });

  test("secret adapter does not reveal plaintext without explicit allow", () => {
    const secret = StorageAdapterRegistry.get("secret");
    const sealed = secret.seal("super-secret");

    expect(secret.envelope(sealed)).toMatchObject({
      hasValue: true,
      encrypted: true,
    });
    expect(() => secret.reveal(sealed)).toThrow(
      /secret_reveal_requires_explicit_allow/
    );
    expect(secret.reveal(sealed, { allowPlaintext: true })).toBe(
      "super-secret"
    );
  });

  test("vector adapter exposes namespace policy", () => {
    const vector = StorageAdapterRegistry.get("vector");

    expect(vector.namespace("research")).toContain("research");
    expect(vector.summary()).toMatchObject({
      providerType: "vector-storage",
      capabilities: expect.objectContaining({
        similaritySearch: true,
      }),
    });
  });
});
