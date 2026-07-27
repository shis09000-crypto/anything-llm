import { API_BASE, AUTH_TIMESTAMP } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";
import {
  createCommunicationRequestId,
  getClientIdentity,
  withClientIdentityHeaders,
} from "@/lib/communication/clientIdentity";
import {
  clearSigningSecretCache,
  getSigningSecret,
  signedRequestHeaders,
} from "@/lib/communication/requestSigningClient";
import { assertSecureHttpUrl } from "@/lib/communication/transportSecurity";
import { setAuthToken } from "@/utils/authTokenStorage";
import { setStoredAuthUser } from "@/utils/authUserStorage";
import { setLoginUserActionNow } from "@/utils/userAction";
import {
  clearSessionRecoveryBinding,
  readSessionRecoveryBinding,
  saveSessionRecoveryBinding,
} from "@/utils/authRecoveryStorage";

export const AUTH_SESSION_RECOVERED_EVENT = "athena-auth-session-recovered";
const AUTH_SESSION_CHANNEL = "athena-auth-session-v1";
const TERMINAL_RECOVERY_REASONS = new Set([
  "account_unavailable",
  "challenge_invalid_or_consumed",
  "client_revoked",
  "device_key_mismatch",
  "device_key_missing",
  "post_quantum_device_key_mismatch",
  "post_quantum_signature_required",
  "recovery_binding_missing",
  "session_absolute_expired",
  "session_client_mismatch",
  "session_idle_expired",
  "session_revoked",
]);

let recoveryPromise = null;
let enrollmentPromise = null;
let authChannel = null;

function apiUrl(path) {
  return assertSecureHttpUrl(
    `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`,
    { kind: "api" }
  );
}

function cleanHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([, value]) => value !== null && value !== undefined
    )
  );
}

async function recoveryRequest(
  path,
  { body = {}, authenticated = false, signed = false, signal } = {}
) {
  const requestId = createCommunicationRequestId();
  const url = apiUrl(path);
  const bodyString = JSON.stringify(body);
  const signatureHeaders = signed
    ? await signedRequestHeaders({
        method: "POST",
        url,
        requestId,
        bodyString,
        signal,
      })
    : {};
  const response = await fetch(url, {
    method: "POST",
    headers: cleanHeaders(
      withClientIdentityHeaders(
        {
          ...(authenticated ? baseHeaders() : {}),
          "Content-Type": "application/json",
          ...signatureHeaders,
        },
        { requestId }
      )
    ),
    body: bodyString,
    signal,
    credentials: "same-origin",
    cache: "no-store",
  });
  const data = await response.json().catch(() => null);
  return { response, data, requestId };
}

function recoveryReason(result, fallback = "session_recovery_unavailable") {
  return String(
    result?.data?.reasonCode ||
      result?.data?.error ||
      result?.error?.code ||
      fallback
  )
    .trim()
    .toLowerCase();
}

function transientRecoveryResult(result) {
  return Boolean(
    result?.data?.retryable ||
      result?.response?.status >= 500 ||
      result?.response?.status === 429 ||
      result?.error
  );
}

function dispatchRecoveredSession(user, token, { broadcast = true } = {}) {
  if (!user || !token) return false;
  setStoredAuthUser(user);
  setAuthToken(token);
  setLoginUserActionNow();
  try {
    window.localStorage.setItem(AUTH_TIMESTAMP, String(Date.now()));
  } catch {}
  try {
    window.dispatchEvent(
      new CustomEvent(AUTH_SESSION_RECOVERED_EVENT, {
        detail: { user, token },
      })
    );
  } catch {}
  if (broadcast) {
    try {
      sessionChannel()?.postMessage({
        type: "session-recovered",
        user,
        token,
      });
    } catch {}
  }
  return true;
}

function sessionChannel() {
  if (
    authChannel ||
    typeof window === "undefined" ||
    typeof BroadcastChannel === "undefined"
  ) {
    return authChannel;
  }
  authChannel = new BroadcastChannel(AUTH_SESSION_CHANNEL);
  authChannel.addEventListener("message", (event) => {
    if (event?.data?.type !== "session-recovered") return;
    dispatchRecoveredSession(event.data.user, event.data.token, {
      broadcast: false,
    });
  });
  return authChannel;
}

async function enrollSessionRecoveryUnlocked({ signal } = {}) {
  const identity = getClientIdentity();
  if (!identity?.clientId) return { enrolled: false, reason: "client_missing" };
  const existing = await readSessionRecoveryBinding(identity.clientId).catch(
    () => null
  );
  if (existing?.recoveryHandle) {
    return {
      enrolled: true,
      existing: true,
      expiresAt: existing.expiresAt || null,
    };
  }
  try {
    const result = await recoveryRequest("/auth/session/recovery/enroll", {
      authenticated: true,
      signed: true,
      signal,
    });
    if (
      !result.response.ok ||
      !result.data?.success ||
      !result.data?.recoveryHandle
    ) {
      return {
        enrolled: false,
        transient: transientRecoveryResult(result),
        reason: recoveryReason(result, "recovery_enrollment_failed"),
      };
    }
    await saveSessionRecoveryBinding({
      clientId: identity.clientId,
      recoveryHandle: result.data.recoveryHandle,
      expiresAt: result.data.expiresAt,
    });
    return { enrolled: true, expiresAt: result.data.expiresAt || null };
  } catch (error) {
    return {
      enrolled: false,
      transient: true,
      reason: error?.code || "recovery_enrollment_unavailable",
    };
  }
}

export async function enrollSessionRecovery({ signal } = {}) {
  if (enrollmentPromise) return enrollmentPromise;
  enrollmentPromise = (async () => {
    const lockManager = globalThis.navigator?.locks;
    if (lockManager?.request) {
      return lockManager.request(
        "athena-auth-session-recovery-enrollment",
        () => enrollSessionRecoveryUnlocked({ signal })
      );
    }
    return enrollSessionRecoveryUnlocked({ signal });
  })().finally(() => {
    enrollmentPromise = null;
  });
  return enrollmentPromise;
}

export async function attemptSessionRecovery({
  source = "bootstrap",
  signal,
} = {}) {
  if (recoveryPromise) return recoveryPromise;
  recoveryPromise = (async () => {
    const identity = getClientIdentity();
    const clientId = identity?.clientId;
    if (!clientId) {
      return {
        recovered: false,
        terminal: true,
        reason: "client_missing",
      };
    }
    const binding = await readSessionRecoveryBinding(clientId).catch(
      () => null
    );
    if (!binding?.recoveryHandle) {
      return {
        recovered: false,
        terminal: true,
        reason: "recovery_binding_missing",
      };
    }

    let startResult;
    try {
      startResult = await recoveryRequest("/auth/session/recovery/start", {
        body: {
          recoveryHandle: binding.recoveryHandle,
          source,
        },
        signal,
      });
    } catch (error) {
      return {
        recovered: false,
        transient: true,
        reason: error?.code || "network_unavailable",
      };
    }
    if (!startResult.response.ok || !startResult.data?.success) {
      const reason = recoveryReason(startResult);
      const transient = transientRecoveryResult(startResult);
      if (!transient || TERMINAL_RECOVERY_REASONS.has(reason)) {
        await clearSessionRecoveryBinding(clientId).catch(() => null);
      }
      return { recovered: false, transient, terminal: !transient, reason };
    }

    let finishResult;
    try {
      finishResult = await recoveryRequest("/auth/session/recovery/finish", {
        body: {
          recoveryTicket: startResult.data.recoveryTicket,
        },
        signed: true,
        signal,
      });
    } catch (error) {
      return {
        recovered: false,
        transient: true,
        reason: error?.code || "network_unavailable",
      };
    }
    if (
      !finishResult.response.ok ||
      !finishResult.data?.success ||
      !finishResult.data?.valid ||
      !finishResult.data?.user ||
      !finishResult.data?.token
    ) {
      const reason = recoveryReason(finishResult);
      const transient = transientRecoveryResult(finishResult);
      if (!transient || TERMINAL_RECOVERY_REASONS.has(reason)) {
        await clearSessionRecoveryBinding(clientId).catch(() => null);
      }
      return { recovered: false, transient, terminal: !transient, reason };
    }

    dispatchRecoveredSession(finishResult.data.user, finishResult.data.token);
    clearSigningSecretCache(clientId);
    void getSigningSecret().catch(() => null);
    return {
      recovered: true,
      user: finishResult.data.user,
      token: finishResult.data.token,
    };
  })().finally(() => {
    recoveryPromise = null;
  });
  return recoveryPromise;
}

export function recoveryReplayAllowed({
  method = "GET",
  headers = {},
  task = null,
} = {}) {
  const normalized = String(method || "GET").toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(normalized)) return true;
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => [
      String(key).toLowerCase(),
      value,
    ])
  );
  return Boolean(
    normalizedHeaders["idempotency-key"] ||
      normalizedHeaders["x-athena-source-action-id"] ||
      task?.sourceActionId ||
      task?.idempotencyKey
  );
}

sessionChannel();
