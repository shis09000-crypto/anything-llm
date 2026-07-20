function apiErrorStatus(error, fallback = 500) {
  const status = Number(error?.httpStatus);
  return Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : fallback;
}

function apiErrorCode(error, fallback = "internal_server_error") {
  if (error?.code === "database_operation_failed")
    return "database_operation_failed";
  return String(error?.code || fallback);
}

function apiErrorMiddleware(error, _request, response, next) {
  if (response.headersSent) return next(error);
  const status = apiErrorStatus(error);
  return response.status(status).json({
    success: false,
    error: apiErrorCode(error),
  });
}

module.exports = { apiErrorCode, apiErrorMiddleware, apiErrorStatus };
