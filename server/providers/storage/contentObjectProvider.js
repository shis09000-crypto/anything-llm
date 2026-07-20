const { contentStoreProvider } = require("../../utils/contentObjects/policy");
const { ContentObjectLocalProvider } = require("./contentObjectLocalProvider");
const { ContentObjectS3Provider } = require("./contentObjectS3Provider");

function contentObjectProvider(envOrProvider = process.env) {
  const provider =
    typeof envOrProvider === "string"
      ? envOrProvider
      : contentStoreProvider(envOrProvider);
  return provider === "s3"
    ? ContentObjectS3Provider
    : ContentObjectLocalProvider;
}

module.exports = {
  ContentObjectLocalProvider,
  ContentObjectS3Provider,
  contentObjectProvider,
};
