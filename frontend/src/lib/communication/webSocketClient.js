import { assertSecureWebSocketUrl } from "./transportSecurity";
import { appendClientIdentityQueryParams } from "./clientIdentity";
import { signedWebSocketEnvelope } from "./requestSigningClient";

export function createWebSocket({ url, protocols } = {}) {
  if (!url) throw new Error("WebSocket url is required.");
  const { url: identityUrl } = appendClientIdentityQueryParams(url);
  return new WebSocket(assertSecureWebSocketUrl(identityUrl), protocols);
}

export function safeSendJson(socket, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return { ok: false, reason: "not_open" };
  }

  try {
    socket.send(JSON.stringify(payload));
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: "send_failed", error };
  }
}

export async function safeSendSignedJson(socket, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return { ok: false, reason: "not_open" };
  }

  try {
    const envelope = await signedWebSocketEnvelope({
      payload,
      url: socket.url,
    });
    socket.send(JSON.stringify(envelope));
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: "sign_or_send_failed", error };
  }
}

export function safeClose(socket, code, reason) {
  if (!socket) return;
  if (
    socket.readyState === WebSocket.CLOSING ||
    socket.readyState === WebSocket.CLOSED
  ) {
    return;
  }

  try {
    socket.close(code, reason);
  } catch {}
}
