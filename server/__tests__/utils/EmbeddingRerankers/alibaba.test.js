const {
  AlibabaEmbeddingReranker,
} = require("../../../utils/EmbeddingRerankers/alibaba");

describe("AlibabaEmbeddingReranker", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("uses qwen3 rerank request format and maps scores back to documents", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { index: 1, relevance_score: 0.91 },
          { index: 0, relevance_score: 0.42 },
        ],
      }),
    });
    global.fetch = fetchMock;

    const reranker = new AlibabaEmbeddingReranker({
      apiKey: "sk-test",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-api/v1/reranks",
      model: "qwen3-rerank",
    });

    const result = await reranker.rerank(
      "什么是重排模型",
      [{ text: "候选一" }, { text: "候选二" }],
      { topK: 2 }
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://dashscope.aliyuncs.com/compatible-api/v1/reranks",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-test",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          model: "qwen3-rerank",
          query: "什么是重排模型",
          documents: ["候选一", "候选二"],
          top_n: 2,
        }),
      })
    );
    expect(result).toEqual([
      {
        rerank_corpus_id: 1,
        rerank_score: 0.91,
        text: "候选二",
      },
      {
        rerank_corpus_id: 0,
        rerank_score: 0.42,
        text: "候选一",
      },
    ]);
  });

  it("still supports legacy output.results response format", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: {
          results: [{ index: 0, relevance_score: 0.7 }],
        },
      }),
    });

    const reranker = new AlibabaEmbeddingReranker({
      apiKey: "sk-test",
      baseUrl:
        "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank",
      model: "gte-rerank-v2",
    });

    const result = await reranker.rerank("query", [{ text: "doc" }], {
      topK: 1,
    });

    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({
      model: "gte-rerank-v2",
      input: {
        query: "query",
        documents: ["doc"],
      },
      parameters: {
        top_n: 1,
        return_documents: false,
      },
    });
    expect(result).toEqual([
      { rerank_corpus_id: 0, rerank_score: 0.7, text: "doc" },
    ]);
  });
});
