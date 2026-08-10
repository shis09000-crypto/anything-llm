const { requestInternalService } = require("../microModules/internalClient");
const { distributedTopology } = require("../microModules/serviceHost");

function remoteRagEnabled(env = process.env) {
  return (
    distributedTopology(env) &&
    String(env.ATHENA_RUNTIME_ROLE || "") !== "rag" &&
    String(env.ATHENA_RAG_CUTOVER || "false").toLowerCase() === "true" &&
    Boolean(String(env.ATHENA_RAG_URL || "").trim())
  );
}

function serializableSearchOptions(options = {}) {
  return {
    namespace: options.namespace || null,
    input: String(options.input || ""),
    similarityThreshold: Number(options.similarityThreshold ?? 0.25),
    topN: Math.max(1, Math.min(Number(options.topN) || 4, 100)),
    filterIdentifiers: Array.isArray(options.filterIdentifiers)
      ? options.filterIdentifiers.map(String).slice(0, 500)
      : [],
    rerank: Boolean(options.rerank),
  };
}

function wrapWithRemoteRag(vectorDb, env = process.env) {
  if (!remoteRagEnabled(env)) return vectorDb;
  return new Proxy(vectorDb, {
    get(target, prop, receiver) {
      if (prop !== "performSimilaritySearch")
        return Reflect.get(target, prop, receiver);
      return async function remoteSimilaritySearch(options = {}) {
        const result = await requestInternalService({
          callerRole: String(env.ATHENA_RUNTIME_ROLE || "api"),
          targetModule: "rag",
          capability: "rag.retrieve",
          contractVersion: "1.0",
          url: `${String(env.ATHENA_RAG_URL).replace(
            /\/+$/,
            ""
          )}/internal/v1/rag/retrieve`,
          body: serializableSearchOptions(options),
          env,
          timeoutMs: Math.max(
            5_000,
            Number(env.ATHENA_RAG_TIMEOUT_MS || 30_000)
          ),
        });
        return result.result;
      };
    },
  });
}

module.exports = {
  remoteRagEnabled,
  serializableSearchOptions,
  wrapWithRemoteRag,
};
