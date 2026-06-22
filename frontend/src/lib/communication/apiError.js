export const API_ERROR_CODES = {
  HTTP_OPEN_ERROR: "HTTP_OPEN_ERROR",
  STREAM_PARSE_ERROR: "STREAM_PARSE_ERROR",
  STREAM_RUNTIME_ERROR: "STREAM_RUNTIME_ERROR",
  API_TIMEOUT_ERROR: "API_TIMEOUT_ERROR",
  TRANSPORT_SECURITY_ERROR: "TRANSPORT_SECURITY_ERROR",
  API_ERROR: "API_ERROR",
};

function statusFromResponse(response) {
  return typeof response?.status === "number" ? response.status : undefined;
}

function messageFromStatus(status) {
  if (!status) return "Request failed.";
  return `Request failed with status ${status}.`;
}

export function normalizeApiError(error, response = null, overrides = {}) {
  const status =
    overrides.status ??
    statusFromResponse(response) ??
    statusFromResponse(error?.response) ??
    error?.status ??
    0;

  const code =
    overrides.code ||
    error?.code ||
    (status ? API_ERROR_CODES.HTTP_OPEN_ERROR : API_ERROR_CODES.API_ERROR);

  const message =
    overrides.message ||
    error?.message ||
    messageFromStatus(status) ||
    "Request failed.";

  return {
    ok: false,
    status,
    code,
    message,
    details: overrides.details ?? error?.details ?? null,
    raw: overrides.raw ?? error?.raw ?? error ?? response ?? null,
  };
}

export function createApiError({
  code = API_ERROR_CODES.API_ERROR,
  status = 0,
  message = "Request failed.",
  details = null,
  raw = null,
} = {}) {
  return normalizeApiError(null, null, {
    code,
    status,
    message,
    details,
    raw,
  });
}

export function apiErrorRaw(error) {
  return error?.raw &&
    typeof error.raw === "object" &&
    !(error.raw instanceof Error)
    ? error.raw
    : null;
}

export function apiErrorFallback(error, fallback) {
  return apiErrorRaw(error) || fallback;
}

export function apiErrorMessage(error, fallback = "Request failed.") {
  const raw = apiErrorRaw(error);
  return raw?.error || raw?.message || error?.message || fallback;
}
