export function readerOpenFailureStatus(response = null, error = null) {
  const status = Number(
    response?.status ||
      error?.status ||
      error?.response?.status ||
      error?.details?.status ||
      error?.raw?.status ||
      0
  );
  return Number.isFinite(status) ? status : 0;
}

export function isRetryableReaderOpenFailure(response = null, error = null) {
  const status = readerOpenFailureStatus(response, error);
  if (status) return status >= 500;
  return true;
}

export function readerOpenFailureDetails(
  response = null,
  data = null,
  error = null,
  fallback = "伴读文档暂时无法打开"
) {
  const raw = error?.raw || null;
  const status = readerOpenFailureStatus(response, error);
  return {
    status,
    retryable: isRetryableReaderOpenFailure(response, error),
    terminal: !!status && status < 500,
    message:
      data?.error ||
      data?.message ||
      raw?.error ||
      raw?.message ||
      error?.message ||
      fallback,
  };
}
