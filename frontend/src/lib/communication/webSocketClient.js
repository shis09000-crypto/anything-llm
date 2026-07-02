import { assertSecureWebSocketUrl } from "./transportSecurity";
import { appendClientIdentityQueryParams } from "./clientIdentity";
import { signedWebSocketEnvelope } from "./requestSigningClient";
import { runScheduledTaskRequest } from "@/utils/tasks/taskRequestMetadata";

export function createWebSocket({ url, protocols, task = null } = {}) {
  if (!url) throw new Error("WebSocket url is required.");
  const { url: identityUrl } = appendClientIdentityQueryParams(url);
  const socket = new WebSocket(
    assertSecureWebSocketUrl(identityUrl),
    protocols
  );
  if (task) scheduleWebSocketLifecycle(socket, { url, task });
  return socket;
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

function scheduleWebSocketLifecycle(socket, { url, task }) {
  void runScheduledTaskRequest(
    ({ signal }) =>
      new Promise((resolve) => {
        const closeSocket = () => {
          safeClose(socket, 1000, "task-abort");
          resolve(null);
        };
        if (signal.aborted) return closeSocket();
        signal.addEventListener("abort", closeSocket, { once: true });
        socket.addEventListener(
          "close",
          () => {
            signal.removeEventListener("abort", closeSocket);
            resolve({ ok: true });
          },
          { once: true }
        );
      }),
    {
      method: "GET",
      path: url,
      task: {
        kind: "websocket",
        priority: "P2",
        policy: "background",
        abortable: true,
        ...task,
      },
      transport: "websocket",
    }
  ).catch(() => {});
}
