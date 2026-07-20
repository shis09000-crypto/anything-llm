import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";
import { API_ERROR_CODES, createApiError, normalizeApiError } from "./apiError";
import { assertSecureHttpUrl } from "./transportSecurity";
import {
  createCommunicationRequestId,
  shouldAttachClientIdentityToUrl,
  withClientIdentityHeaders,
} from "./clientIdentity";
import {
  communicationByteLength,
  recordCommunicationEvent,
} from "./communicationMetrics";
import { runScheduledTaskRequest } from "@/utils/tasks/taskRequestMetadata";
import { recoveryCenter } from "@/utils/recovery/recoveryCenter";

export const BLOB_KINDS = {
  ttsAudio: "tts_audio",
  readerOriginal: "reader_original",
  readerPreview: "reader_preview",
  readerThumbnail: "reader_thumbnail",
  avatar: "avatar",
  logo: "logo",
  visualAsset: "visual_asset",
  generatedFile: "generated_file",
  exportText: "export_text",
  modelDownloadStream: "model_download_stream",
  chatAttachment: "chat_attachment",
  chatContent: "chat_content",
};

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function durationSince(startedAt) {
  return Math.round(nowMs() - startedAt);
}

function devLog(phase, metadata = {}) {
  if (!import.meta.env.DEV) return;
  console.debug(`[blobClient] ${phase}`, metadata);
}

function handleBlobRecovery(error, context = {}) {
  return recoveryCenter.handle(error, {
    source: context.blobKind?.startsWith?.("reader")
      ? "reader"
      : "communication",
    requestId: context.requestId,
    path: context.path,
    communicationScene: context.communicationScene,
    foreground: context.foreground,
    scope: {
      route: "blob",
      blobKind: context.blobKind,
      path: context.path,
      communicationScene: context.communicationScene || undefined,
    },
  });
}

function cleanHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([, value]) => value !== null && value !== undefined
    )
  );
}

function requestSignal({ signal, timeoutMs }) {
  const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
  if (!hasTimeout) {
    return {
      signal,
      cleanup: () => {},
      didTimeout: () => false,
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromExternal = () => controller.abort(signal?.reason);
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  if (signal?.aborted) {
    abortFromExternal();
  } else {
    signal?.addEventListener("abort", abortFromExternal, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abortFromExternal);
    },
    didTimeout: () => timedOut,
  };
}

export function downloadUrl(pathOrUrl = "") {
  if (!pathOrUrl) return assertSecureHttpUrl(API_BASE, { kind: "blob" });
  if (/^(https?:|blob:|data:)/i.test(pathOrUrl)) {
    return assertSecureHttpUrl(pathOrUrl, { kind: "blob" });
  }

  if (pathOrUrl.startsWith("/api/")) {
    if (API_BASE.startsWith("http")) {
      return assertSecureHttpUrl(
        `${API_BASE.replace(/\/api\/?$/, "")}${pathOrUrl}`,
        { kind: "blob" }
      );
    }
    return assertSecureHttpUrl(pathOrUrl, { kind: "blob" });
  }

  return assertSecureHttpUrl(
    `${API_BASE}${pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`,
    { kind: "blob" }
  );
}

function blobHeaders(
  headers = {},
  { includeBaseHeaders = true, includeClientIdentity = true, requestId } = {}
) {
  const nextHeaders = cleanHeaders({
    ...(includeBaseHeaders ? baseHeaders() : {}),
    ...headers,
  });
  return includeClientIdentity
    ? withClientIdentityHeaders(nextHeaders, { requestId })
    : nextHeaders;
}

function bodyForRequest(body, rawBody = false) {
  if (body === undefined) return undefined;
  return rawBody ? body : JSON.stringify(body);
}

async function parseErrorBody(response) {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text || response.statusText };
  }
}

function logPayload({
  requestId,
  blobKind,
  path,
  status = 0,
  durationMs = 0,
  result,
  code,
  message,
} = {}) {
  return {
    requestId,
    blobKind,
    path,
    status,
    durationMs,
    result,
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
  };
}

function blobDetails({
  requestId,
  blobKind,
  path,
  status = 0,
  code = API_ERROR_CODES.API_ERROR,
  message = "Blob request failed.",
  timeoutMs = undefined,
} = {}) {
  return {
    requestId,
    blobKind,
    path,
    status,
    code,
    message,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

async function requestBodyCore(kind, path, options = {}, reader) {
  const {
    signal,
    timeoutMs,
    headers = {},
    includeBaseHeaders = true,
    blobKind = "unknown",
    method = "GET",
    body,
    rawBody = false,
    communicationScene = null,
    task: _task,
    schedulerInternal: _schedulerInternal,
    ...rest
  } = options;
  const normalizedMethod = method.toUpperCase();
  const requestId = createCommunicationRequestId();
  const startedAt = nowMs();
  const signalState = requestSignal({ signal, timeoutMs });
  const url = downloadUrl(path);

  devLog(
    "start",
    logPayload({
      requestId,
      blobKind,
      path,
      result: "started",
    })
  );

  try {
    const response = await fetch(url, {
      method: normalizedMethod,
      headers: blobHeaders(headers, {
        includeBaseHeaders,
        includeClientIdentity: shouldAttachClientIdentityToUrl(url),
        requestId,
      }),
      body: bodyForRequest(body, rawBody),
      signal: signalState.signal,
      ...rest,
    });

    if (!response.ok) {
      const raw = await parseErrorBody(response.clone());
      const message =
        raw?.error ||
        raw?.message ||
        `${kind} request failed with status ${response.status}.`;
      const apiError = normalizeApiError(null, response, {
        code: API_ERROR_CODES.HTTP_OPEN_ERROR,
        message,
        details: blobDetails({
          requestId,
          blobKind,
          path,
          status: response.status,
          code: API_ERROR_CODES.HTTP_OPEN_ERROR,
          message,
        }),
        raw,
      });
      devLog(
        "failure",
        logPayload({
          requestId,
          blobKind,
          path,
          status: response.status,
          durationMs: durationSince(startedAt),
          result: "failure",
          code: apiError.code,
          message: apiError.message,
        })
      );
      throw apiError;
    }

    const payload = await reader(response);
    const responseBytes =
      payload?.blob?.size ||
      communicationByteLength(payload?.text || "") ||
      Number(response.headers?.get?.("content-length") || 0) ||
      0;
    devLog(
      "success",
      logPayload({
        requestId,
        blobKind,
        path,
        status: response.status,
        durationMs: durationSince(startedAt),
        result: response.status === 204 ? "empty" : "success",
      })
    );
    recordCommunicationEvent({
      requestId,
      type: "blob",
      method: normalizedMethod,
      path,
      blobKind,
      status: response.status,
      durationMs: durationSince(startedAt),
      requestBytes: communicationByteLength(
        bodyForRequest(body, rawBody) || ""
      ),
      responseBytes,
      communicationScene,
      serverTiming: response.headers?.get?.("Server-Timing") || null,
      ok: true,
    });
    return { response, requestId, ...payload };
  } catch (error) {
    if (signalState.didTimeout()) {
      const message = `${kind} request timed out after ${timeoutMs}ms.`;
      const apiError = createApiError({
        code: API_ERROR_CODES.API_TIMEOUT_ERROR,
        status: 0,
        message,
        details: blobDetails({
          requestId,
          blobKind,
          path,
          status: 0,
          code: API_ERROR_CODES.API_TIMEOUT_ERROR,
          message,
          timeoutMs,
        }),
        raw: error,
      });
      handleBlobRecovery(apiError, {
        requestId,
        blobKind,
        path,
        communicationScene,
      });
      devLog(
        "timeout",
        logPayload({
          requestId,
          blobKind,
          path,
          status: 0,
          durationMs: durationSince(startedAt),
          result: "timeout",
          code: apiError.code,
          message: apiError.message,
        })
      );
      throw apiError;
    }
    if (error?.name === "AbortError") throw error;
    if (error?.ok === false) {
      handleBlobRecovery(error, {
        requestId,
        blobKind,
        path,
        communicationScene,
      });
      throw error;
    }

    const apiError = normalizeApiError(error, null, {
      details: blobDetails({
        requestId,
        blobKind,
        path,
        status: error?.status || 0,
        code: error?.code || API_ERROR_CODES.API_ERROR,
        message: error?.message || `${kind} request failed.`,
      }),
    });
    handleBlobRecovery(apiError, {
      requestId,
      blobKind,
      path,
      communicationScene,
    });
    devLog(
      "failure",
      logPayload({
        requestId,
        blobKind,
        path,
        status: apiError.status,
        durationMs: durationSince(startedAt),
        result: "failure",
        code: apiError.code,
        message: apiError.message,
      })
    );
    recordCommunicationEvent({
      requestId,
      type: "blob",
      method: normalizedMethod,
      path,
      blobKind,
      status: apiError.status,
      durationMs: durationSince(startedAt),
      requestBytes: communicationByteLength(
        bodyForRequest(body, rawBody) || ""
      ),
      responseBytes: 0,
      communicationScene,
      ok: false,
      error: apiError.message,
    });
    throw apiError;
  } finally {
    signalState.cleanup();
  }
}

async function requestBody(kind, path, options = {}, reader) {
  const {
    method = "GET",
    signal,
    task,
    schedulerInternal = false,
    communicationScene = null,
    blobKind = "unknown",
  } = options;
  if (schedulerInternal || task === false) {
    return requestBodyCore(kind, path, options, reader);
  }

  return runScheduledTaskRequest(
    ({ signal: scheduledSignal }) =>
      requestBodyCore(
        kind,
        path,
        {
          ...options,
          signal: scheduledSignal,
          task: false,
          schedulerInternal: true,
        },
        reader
      ),
    {
      method,
      path,
      signal,
      task: task || {
        kind: `blob:${blobKind}`,
        priority:
          blobKind === BLOB_KINDS.readerThumbnail ||
          String(path || "").includes("thumbnail")
            ? "P4"
            : undefined,
      },
      communicationScene,
      transport: "blob",
    }
  );
}

export function requestBlob(path, options = {}) {
  return requestBody("Blob", path, options, async (response) => ({
    blob: await response.blob(),
  }));
}

export function requestText(path, options = {}) {
  return requestBody("Text", path, options, async (response) => ({
    text: await response.text(),
  }));
}
