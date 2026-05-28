const { AlibabaEmbeddingReranker } = require("./alibaba");
const { NativeEmbeddingReranker } = require("./native");

function getEmbeddingReranker() {
  const provider = process.env.RERANK_PROVIDER || "native";
  switch (provider) {
    case "alibaba":
      return new AlibabaEmbeddingReranker();
    case "native":
    default:
      return new NativeEmbeddingReranker();
  }
}

module.exports = {
  getEmbeddingReranker,
};
