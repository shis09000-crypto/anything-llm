class ModelDataAccessError extends Error {
  constructor(operation, cause, context = {}) {
    super("database_operation_failed", { cause });
    this.name = "ModelDataAccessError";
    this.code = "database_operation_failed";
    this.httpStatus = 503;
    this.operation = String(operation || "unknown");
    this.context = context;
  }
}

function modelDataAccessError(operation, cause, context = {}) {
  if (cause instanceof ModelDataAccessError) return cause;
  return new ModelDataAccessError(operation, cause, context);
}

function throwModelDataAccessError(operation, cause, context = {}) {
  if (cause instanceof ModelDataAccessError) throw cause;
  const error = modelDataAccessError(operation, cause, context);
  console.error("[ModelDataAccess] database operation failed", {
    operation: error.operation,
    code: cause?.code || cause?.name || "database_error",
    context,
  });
  throw error;
}

module.exports = {
  ModelDataAccessError,
  modelDataAccessError,
  throwModelDataAccessError,
};
