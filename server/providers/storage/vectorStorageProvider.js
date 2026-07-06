const {
  diagnosticSummary,
  vectorNamespace,
  vectorNamespacePrefix,
} = require("../../utils/environment");

const VectorStorageProvider = {
  adapterName: process.env.VECTOR_DB || "lancedb",
  providerType: "vector-storage",

  capabilities() {
    return {
      similaritySearch: true,
      namespaceDelete: true,
      transactions: false,
      remote: this.adapterName !== "lancedb",
      adapterTargets: {
        postgresPgvector: "supported-existing",
        redisVector: "reserved",
      },
    };
  },

  summary() {
    const diagnostics = diagnosticSummary();
    return {
      adapterName: this.adapterName,
      providerType: this.providerType,
      root: diagnostics.vectorStore.root,
      namespacePrefix: vectorNamespacePrefix(),
      capabilities: this.capabilities(),
    };
  },

  namespace(workspaceSlug = "") {
    return vectorNamespace(workspaceSlug);
  },
};

module.exports = { VectorStorageProvider };
