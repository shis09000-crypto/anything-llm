const mockRequestInternalService = jest.fn();

jest.mock("../../utils/microModules/internalClient", () => ({
  requestInternalService: (...args) => mockRequestInternalService(...args),
}));

const { wrapWithRemoteRag } = require("../../utils/rag/remoteProvider");

describe("remote RAG AICP contract", () => {
  test("declares the provider, capability, and version for retrieval", async () => {
    mockRequestInternalService.mockResolvedValue({
      result: { sources: [], message: null },
    });
    const env = {
      ATHENA_RUNTIME_TOPOLOGY: "distributed",
      ATHENA_RUNTIME_ROLE: "api",
      ATHENA_RAG_CUTOVER: "true",
      ATHENA_RAG_URL: "http://rag:3028",
    };
    const vectorDb = wrapWithRemoteRag({}, env);

    await vectorDb.performSimilaritySearch({
      namespace: "workspace",
      input: "test topic",
    });

    expect(mockRequestInternalService).toHaveBeenCalledWith(
      expect.objectContaining({
        callerRole: "api",
        targetModule: "rag",
        capability: "rag.retrieve",
        contractVersion: "1.0",
        url: "http://rag:3028/internal/v1/rag/retrieve",
      })
    );
  });
});
