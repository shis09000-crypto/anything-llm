import { API_ERROR_CODES } from "../../lib/communication/apiError.js";

export const RECOVERY_CLASSIFICATIONS = {
  silent: "silent",
  retryable: "retryable",
  rollback: "rollback",
  reauth: "reauth",
  permission: "permission",
  fatal: "fatal",
  background: "background",
};

const SIGNING_RECOVERY_CODES = new Set([
  API_ERROR_CODES.INVALID_SIGNATURE,
  API_ERROR_CODES.SIGNING_SECRET_ROTATED,
]);

function stringValue(value = "") {
  return String(value || "");
}

export function recoveryErrorCode(error = null) {
  return (
    error?.code ||
    error?.raw?.code ||
    error?.raw?.error ||
    error?.details?.code ||
    error?.details?.error ||
    null
  );
}

export function recoveryErrorStatus(error = null) {
  const status = Number(
    error?.status ||
      error?.response?.status ||
      error?.details?.status ||
      error?.raw?.status ||
      0
  );
  return Number.isFinite(status) ? status : 0;
}

export function recoveryErrorMessage(error = null) {
  return (
    error?.raw?.error ||
    error?.raw?.message ||
    error?.details?.message ||
    error?.message ||
    stringValue(error)
  );
}

export function isAbortLikeError(error = null, context = {}) {
  if (context?.aborted) return true;
  const message = recoveryErrorMessage(error);
  return (
    error?.name === "AbortError" ||
    error?.code === "ABORT_ERR" ||
    /aborted|aborterror|task aborted/i.test(message)
  );
}

export function isStaleLikeError(error = null, context = {}) {
  const status = stringValue(error?.status || error?.taskStatus || "");
  const message = recoveryErrorMessage(error);
  return (
    context?.stale === true ||
    error?.stale === true ||
    status === "stale" ||
    /stale task|task stale|not current|task-not-current/i.test(message)
  );
}

function pathFrom(error = null, context = {}) {
  return stringValue(context.path || error?.details?.path || error?.path);
}

function sceneFrom(error = null, context = {}) {
  return stringValue(
    context.communicationScene ||
      error?.details?.communicationScene ||
      error?.communicationScene
  );
}

function isNetworkLike(error = null) {
  const message = recoveryErrorMessage(error);
  return (
    error?.code === API_ERROR_CODES.API_ERROR ||
    /failed to fetch|networkerror|network error|load failed|connection failed|network closed/i.test(
      message
    )
  );
}

function isTimeoutLike(error = null) {
  return (
    recoveryErrorCode(error) === API_ERROR_CODES.API_TIMEOUT_ERROR ||
    /timeout|timed out/i.test(recoveryErrorMessage(error))
  );
}

function isStreamOrWebSocketLike(error = null, context = {}) {
  const code = recoveryErrorCode(error);
  const source = stringValue(context.source).toLowerCase();
  const message = recoveryErrorMessage(error);
  return (
    source === "agent" ||
    source === "crypto" ||
    source === "websocket" ||
    code === API_ERROR_CODES.STREAM_RUNTIME_ERROR ||
    /websocket|sse|stream|connection interrupted|connection failed|reconnect/i.test(
      message
    )
  );
}

function isBackgroundWork(error = null, context = {}) {
  const source = stringValue(context.source).toLowerCase();
  const path = pathFrom(error, context).toLowerCase();
  const scene = sceneFrom(error, context).toLowerCase();
  return (
    context?.background === true ||
    context?.maintenance === true ||
    context?.activityId ||
    source === "activity" ||
    (source === "reader" && context?.foreground !== true) ||
    /postprocess|classification|thumbnail/.test(path) ||
    /maintenance|patrol|background|postprocess|classification|thumbnail/.test(
      scene
    )
  );
}

function ownerMismatch(error = null) {
  return /owner mismatch|resource owner|not owner|forbidden/i.test(
    recoveryErrorMessage(error)
  );
}

export function classifyError(error = null, context = {}) {
  const source = stringValue(context.source || "unknown");
  const code = recoveryErrorCode(error);
  const status = recoveryErrorStatus(error);
  const background = isBackgroundWork(error, context);
  const aborted = isAbortLikeError(error, context);
  const stale = isStaleLikeError(error, context);

  if (aborted || stale) {
    return {
      classification: RECOVERY_CLASSIFICATIONS.silent,
      code,
      status,
      reason: stale ? "stale" : "abort",
      silent: true,
      shouldRollback: false,
      shouldToast: false,
      shouldReauth: false,
      recoveryAction: null,
      source,
    };
  }

  if (code === API_ERROR_CODES.CLIENT_REVOKED) {
    return {
      classification: RECOVERY_CLASSIFICATIONS.permission,
      code,
      status: status || 403,
      reason: "client-revoked",
      silent: false,
      shouldRollback: source === "optimistic-action",
      shouldToast: true,
      shouldReauth: false,
      recoveryAction: "clear-signing-cache/client-identity",
      source,
    };
  }

  if (SIGNING_RECOVERY_CODES.has(code)) {
    return {
      classification: RECOVERY_CLASSIFICATIONS.retryable,
      code,
      status,
      reason: "signing-retry",
      silent: false,
      shouldRollback: source === "optimistic-action",
      shouldToast: source === "optimistic-action",
      shouldReauth: false,
      recoveryAction: "refresh-signing-secret",
      source,
    };
  }

  if (status === 401) {
    return {
      classification: RECOVERY_CLASSIFICATIONS.reauth,
      code,
      status,
      reason: "reauth",
      silent: false,
      shouldRollback: source === "optimistic-action",
      shouldToast: true,
      shouldReauth: true,
      recoveryAction: "reauth",
      source,
    };
  }

  if (status === 403 || ownerMismatch(error)) {
    return {
      classification: RECOVERY_CLASSIFICATIONS.permission,
      code,
      status: status || 403,
      reason: "permission",
      silent: false,
      shouldRollback: source === "optimistic-action",
      shouldToast: true,
      shouldReauth: false,
      recoveryAction: "permission-check",
      source,
    };
  }

  if (background) {
    return {
      classification: RECOVERY_CLASSIFICATIONS.background,
      code,
      status,
      reason: "background",
      silent: false,
      shouldRollback: false,
      shouldToast: context?.foreground === true,
      shouldReauth: false,
      recoveryAction: "activity-background-failure",
      source,
    };
  }

  if (source === "optimistic-action") {
    return {
      classification: RECOVERY_CLASSIFICATIONS.rollback,
      code,
      status,
      reason: "optimistic-server-failed",
      silent: false,
      shouldRollback: true,
      shouldToast: true,
      shouldReauth: false,
      recoveryAction: "rollback",
      source,
    };
  }

  if (
    isTimeoutLike(error) ||
    isNetworkLike(error) ||
    isStreamOrWebSocketLike(error, context)
  ) {
    return {
      classification: RECOVERY_CLASSIFICATIONS.retryable,
      code,
      status,
      reason: isTimeoutLike(error) ? "timeout" : "network",
      silent: false,
      shouldRollback: false,
      shouldToast: false,
      shouldReauth: false,
      recoveryAction: "retry",
      source,
    };
  }

  return {
    classification: RECOVERY_CLASSIFICATIONS.fatal,
    code,
    status,
    reason: "fatal",
    silent: false,
    shouldRollback: source === "optimistic-action",
    shouldToast: source === "optimistic-action",
    shouldReauth: false,
    recoveryAction: "surface-error",
    source,
  };
}
