const { FileStorageProvider } = require("./fileStorageProvider");
const { SecretStoreProvider } = require("./secretStoreProvider");
const { VectorStorageProvider } = require("./vectorStorageProvider");
const { contentObjectProvider } = require("./contentObjectProvider");

const RESERVED_ADAPTERS = Object.freeze({
  postgres: {
    adapterName: "postgres",
    providerType: "relational-database",
    status: "reserved",
    reason: "Repository contracts are kept database-portable before migration.",
  },
  redis: {
    adapterName: "redis",
    providerType: "cache-and-replay",
    status: "reserved",
    reason: "Realtime replay/cache adapter is intentionally deferred.",
  },
});

const adapters = {
  file: FileStorageProvider,
  vector: VectorStorageProvider,
  secret: SecretStoreProvider,
  objectStorage: contentObjectProvider(),
};

const StorageAdapterRegistry = {
  adapters,
  reserved: RESERVED_ADAPTERS,

  get(name) {
    const adapter = adapters[name];
    if (!adapter) {
      const error = new Error(`Unknown storage adapter: ${name}`);
      error.code = "STORAGE_ADAPTER_NOT_FOUND";
      throw error;
    }
    return adapter;
  },

  summary() {
    return {
      active: Object.fromEntries(
        Object.entries(adapters).map(([key, adapter]) => [
          key,
          adapter.summary(),
        ])
      ),
      reserved: RESERVED_ADAPTERS,
    };
  },
};

module.exports = { StorageAdapterRegistry };
