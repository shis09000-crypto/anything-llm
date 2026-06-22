import { assertSecureWebSocketUrl } from "./transportSecurity";

export function createWebSocket({ url, protocols } = {}) {
  if (!url) throw new Error("WebSocket url is required.");
  return new WebSocket(assertSecureWebSocketUrl(url), protocols);
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
