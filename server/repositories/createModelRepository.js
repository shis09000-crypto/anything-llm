function createModelRepository(model, metadata = {}) {
  const repository = Object.create(model);
  Object.defineProperties(repository, {
    repositoryName: {
      value: metadata.repositoryName || metadata.domain || "repository",
      enumerable: true,
    },
    dataDomain: {
      value: metadata.domain || "unknown",
      enumerable: true,
    },
    sourceModel: {
      value: model,
      enumerable: false,
    },
  });
  return repository;
}

module.exports = { createModelRepository };
