const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR || path.resolve(__dirname, "../../storage");

const {
  StorageAdapterRegistry,
} = require("../../providers/storage/storageAdapterRegistry");

describe("StorageAdapterRegistry", () => {
  test("exposes active storage adapters and only genuinely future adapters as reserved", () => {
    const summary = StorageAdapterRegistry.summary();

    expect(summary.active).toHaveProperty("file");
    expect(summary.active).toHaveProperty("vector");
    expect(summary.active).toHaveProperty("secret");
    expect(summary.active.objectStorage).toMatchObject({
      providerType: "object-storage",
    });
    expect(summary.reserved).toMatchObject({
      postgres: { status: "reserved" },
      redis: { status: "reserved" },
    });
    expect(summary.reserved).not.toHaveProperty("objectStorage");
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

  test("file adapter reads, writes, deletes, and rejects paths outside storage root", () => {
    const previousStorageBase = process.env.ANYTHINGLLM_STORAGE_BASE_DIR;
    const previousStorageDir = process.env.STORAGE_DIR;
    const previousStorageApplied = process.env.ANYTHINGLLM_ENV_STORAGE_APPLIED;
    const previousAppEnv = process.env.APP_ENV;
    const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "file-provider-"));
    try {
      process.env.ANYTHINGLLM_STORAGE_BASE_DIR = tempBase;
      process.env.APP_ENV = "development";
      delete process.env.ANYTHINGLLM_ENV_STORAGE_APPLIED;
      const file = StorageAdapterRegistry.get("file");

      const written = file.writeFilePath("nested/thing.txt", "hello", {
        encoding: "utf8",
      });
      expect(written).toContain(path.join("development", "nested"));
      expect(file.readFilePath("nested/thing.txt", "utf8")).toBe("hello");
      expect(file.statPath("nested/thing.txt")).toMatchObject({
        isFile: true,
        size: 5,
      });
      expect(() =>
        file.resolvePath(path.join(tempBase, "outside.txt"))
      ).toThrow(/file_storage_path_outside_root/);

      expect(file.deletePath("nested", { recursive: true })).toBe(true);
      expect(file.existsPath("nested")).toBe(false);
    } finally {
      fs.rmSync(tempBase, { recursive: true, force: true });
      if (previousStorageBase === undefined)
        delete process.env.ANYTHINGLLM_STORAGE_BASE_DIR;
      else process.env.ANYTHINGLLM_STORAGE_BASE_DIR = previousStorageBase;
      if (previousStorageDir === undefined) delete process.env.STORAGE_DIR;
      else process.env.STORAGE_DIR = previousStorageDir;
      if (previousStorageApplied === undefined)
        delete process.env.ANYTHINGLLM_ENV_STORAGE_APPLIED;
      else process.env.ANYTHINGLLM_ENV_STORAGE_APPLIED = previousStorageApplied;
      if (previousAppEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = previousAppEnv;
    }
  });
});
