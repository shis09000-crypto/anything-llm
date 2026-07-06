const {
  UserMemory,
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_LABELS,
  MEMORY_CATEGORY_DESCRIPTIONS,
  MEMORY_SCHEMA_INIT_ERROR,
  MEMORY_OWNER_REQUIRED_ERROR,
  isMemorySchemaMissingError,
} = require("../models/userMemory");
const { createModelRepository } = require("./createModelRepository");

const UserMemoryRepository = createModelRepository(UserMemory, {
  domain: "user-memory",
  repositoryName: "UserMemoryRepository",
});

Object.defineProperties(UserMemoryRepository, {
  categories: {
    value: UserMemory.categories || MEMORY_CATEGORIES,
    enumerable: true,
  },
  labels: {
    value: UserMemory.labels || MEMORY_CATEGORY_LABELS,
    enumerable: true,
  },
  descriptions: {
    value: UserMemory.descriptions || MEMORY_CATEGORY_DESCRIPTIONS,
    enumerable: true,
  },
  schemaInitError: {
    value: MEMORY_SCHEMA_INIT_ERROR,
    enumerable: true,
  },
  ownerRequiredError: {
    value: MEMORY_OWNER_REQUIRED_ERROR,
    enumerable: true,
  },
});

UserMemoryRepository.isMemorySchemaMissingError = isMemorySchemaMissingError;

module.exports = { UserMemoryRepository };
