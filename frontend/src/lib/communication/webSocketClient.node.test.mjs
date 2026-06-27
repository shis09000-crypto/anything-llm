import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";

const webSocketClientUrl = new URL("./webSocketClient.js", import.meta.url);

async function loadWebSocketClient() {
  const source = await readFile(webSocketClientUrl, "utf8");
  globalThis.__webSocketClientTestSecurity = {
    assertSecureWebSocketUrl: (url) => url,
  };
  globalThis.__webSocketClientTestIdentity = {
    appendClientIdentityQueryParams: (url) => {
      const next = new URL(url);
      next.searchParams.set("athenaClientId", "client-ws-test");
      next.searchParams.set("athenaPlatform", "web");
      next.searchParams.set("athenaAppVersion", "test");
      next.searchParams.set("athenaRequestId", "req-ws-test");
      return { url: next.toString(), requestId: "req-ws-test" };
    },
  };
  globalThis.__webSocketClientTestSigning = {
    signedWebSocketEnvelope: async ({ payload }) => ({
      type: "athenaSignedMessage",
      signatureVersion: "v1",
      signed: { clientId: "client-ws-test", requestId: "req-signed" },
      payload,
    }),
  };

  const transformed = source
    .replace(
      'import { assertSecureWebSocketUrl } from "./transportSecurity";',
      "const { assertSecureWebSocketUrl } = globalThis.__webSocketClientTestSecurity;"
    )
    .replace(
      'import { appendClientIdentityQueryParams } from "./clientIdentity";',
      "const { appendClientIdentityQueryParams } = globalThis.__webSocketClientTestIdentity;"
    )
    .replace(
      'import { signedWebSocketEnvelope } from "./requestSigningClient";',
      "const { signedWebSocketEnvelope } = globalThis.__webSocketClientTestSigning;"
    );

  return import(
    `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${Date.now()}-${Math.random()}`
  );
}

test("createWebSocket appends identity query without dropping existing params", async () => {
  const originalWebSocket = globalThis.WebSocket;
  let createdUrl;
  globalThis.WebSocket = class TestWebSocket {
    static OPEN = 1;
    constructor(url) {
      createdUrl = url;
      this.readyState = TestWebSocket.OPEN;
    }
  };

  try {
    const { createWebSocket } = await loadWebSocketClient();
    createWebSocket({
      url: "wss://athena.example.com/api/agent-invocation/demo?token=abc&resume=1",
    });

    const parsed = new URL(createdUrl);
    assert.equal(parsed.searchParams.get("token"), "abc");
    assert.equal(parsed.searchParams.get("resume"), "1");
    assert.equal(parsed.searchParams.get("athenaClientId"), "client-ws-test");
    assert.equal(parsed.searchParams.get("athenaRequestId"), "req-ws-test");
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test("safeSendSignedJson sends a signed websocket envelope", async () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class TestWebSocket {
    static OPEN = 1;
  };

  try {
    const { safeSendSignedJson } = await loadWebSocketClient();
    const socket = {
      readyState: globalThis.WebSocket.OPEN,
      url: "wss://athena.example.com/api/agent-invocation/demo",
      sent: [],
      send(payload) {
        this.sent.push(payload);
      },
    };
    const result = await safeSendSignedJson(socket, {
      type: "toolApprovalResponse",
      requestId: "r1",
      approved: true,
    });
    assert.deepEqual(result, { ok: true });
    const envelope = JSON.parse(socket.sent[0]);
    assert.equal(envelope.type, "athenaSignedMessage");
    assert.equal(envelope.payload.type, "toolApprovalResponse");
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});
