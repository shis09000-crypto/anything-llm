const DEFAULT_BASE_URL =
  "https://dashscope.aliyuncs.com/compatible-api/v1/reranks";
const DEFAULT_MODEL = "qwen3-rerank";

class AlibabaEmbeddingReranker {
  constructor({
    apiKey = process.env.RERANK_API_KEY,
    baseUrl = process.env.RERANK_BASE_URL || DEFAULT_BASE_URL,
    model = process.env.RERANK_MODEL_PREF || DEFAULT_MODEL,
  } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.model = model;
  }

  log(text, ...args) {
    console.log(`\x1b[36m[AlibabaEmbeddingReranker]\x1b[0m ${text}`, ...args);
  }

  async rerank(query, documents, options = { topK: 4 }) {
    if (!this.apiKey) throw new Error("Alibaba rerank API key is required.");
    if (!query || !Array.isArray(documents) || documents.length === 0)
      return [];

    const topK = Number(options?.topK || 4);
    const start = Date.now();
    this.log(`Reranking ${documents.length} documents with ${this.model}...`);

    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(this.#requestBody({ query, documents, topK })),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        data?.message || data?.error?.message || data?.code || response.status;
      throw new Error(`Alibaba rerank request failed: ${message}`);
    }

    const results = Array.isArray(data?.results)
      ? data.results
      : Array.isArray(data?.output?.results)
        ? data.output.results
        : [];

    const reranked = results
      .map((item) => {
        const index = Number(item.index);
        if (!Number.isInteger(index) || !documents[index]) return null;
        return {
          rerank_corpus_id: index,
          rerank_score: Number(item.relevance_score || 0),
          ...documents[index],
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.rerank_score - a.rerank_score)
      .slice(0, topK);

    this.log(
      `Reranking ${documents.length} documents to top ${topK} took ${Date.now() - start}ms`
    );
    return reranked;
  }

  #requestBody({ query, documents, topK }) {
    const textDocuments = documents.map((doc) => doc.text || "");
    if (this.model === "qwen3-rerank") {
      return {
        model: this.model,
        query,
        documents: textDocuments,
        top_n: topK,
      };
    }

    return {
      model: this.model,
      input: {
        query,
        documents: textDocuments,
      },
      parameters: {
        top_n: topK,
        return_documents: false,
      },
    };
  }
}

module.exports = {
  AlibabaEmbeddingReranker,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
};
