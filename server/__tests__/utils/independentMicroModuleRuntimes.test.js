/* eslint-env jest */

const { createApiScope } = require("../../utils/microModules/scopedApi");
const {
  remoteRagEnabled,
  serializableSearchOptions,
} = require("../../utils/rag/remoteProvider");
const {
  COLOCATED_MODULES,
  colocatedModuleReadiness,
} = require("../../utils/modulePlatform/apiProbeHost");

function runScope(scope, path) {
  const next = jest.fn();
  const status = jest.fn();
  const json = jest.fn();
  status.mockReturnValue({ json });
  scope({ path }, { status }, next);
  return { next, status, json };
}

describe("independent micro-module runtime boundaries", () => {
  test("scopes compatibility routers to the owning module", () => {
    const scope = createApiScope({
      exact: ["/request-token"],
      prefixes: ["/auth"],
      patterns: [/^\/workspace\/[^/]+\/update-embeddings$/],
    });
    expect(runScope(scope, "/request-token").next).toHaveBeenCalledTimes(1);
    expect(runScope(scope, "/auth/passkeys").next).toHaveBeenCalledTimes(1);
    expect(
      runScope(scope, "/workspace/example/update-embeddings").next
    ).toHaveBeenCalledTimes(1);
    const rejected = runScope(scope, "/workspace/example/stream-chat");
    expect(rejected.next).not.toHaveBeenCalled();
    expect(rejected.status).toHaveBeenCalledWith(404);
    expect(rejected.json).toHaveBeenCalledWith({
      success: false,
      error: "module_route_not_owned",
    });
  });

  test("activates remote RAG only for non-RAG distributed callers", () => {
    const env = {
      ATHENA_RUNTIME_TOPOLOGY: "distributed",
      ATHENA_RUNTIME_ROLE: "chat-runtime",
      ATHENA_RAG_CUTOVER: "true",
      ATHENA_RAG_URL: "https://rag:3028",
    };
    expect(remoteRagEnabled(env)).toBe(true);
    expect(remoteRagEnabled({ ...env, ATHENA_RUNTIME_ROLE: "rag" })).toBe(
      false
    );
    expect(remoteRagEnabled({ ...env, ATHENA_RAG_CUTOVER: "false" })).toBe(
      false
    );
    expect(
      serializableSearchOptions({
        namespace: "workspace",
        input: "query",
        topN: 999,
        filterIdentifiers: ["a"],
        rerank: true,
        LLMConnector: { secret: "must-not-cross-rpc" },
      })
    ).toEqual({
      namespace: "workspace",
      input: "query",
      similarityThreshold: 0.25,
      topN: 100,
      filterIdentifiers: ["a"],
      rerank: true,
    });
  });

  test("the API readiness host no longer impersonates independent modules", () => {
    expect([...COLOCATED_MODULES]).toEqual(["athena-api"]);
    expect(colocatedModuleReadiness("authentication")).toBeNull();
    expect(colocatedModuleReadiness("knowledge-ingest")).toBeNull();
    expect(colocatedModuleReadiness("rag")).toBeNull();
  });
});
