import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const clientUrl = new URL("./agentWebSocketClient.js", import.meta.url);
const protocolUrl = new URL("./agentWebSocketProtocol.js", import.meta.url);

class FakeWindow extends EventTarget {}

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    super();
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  message(payload) {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: typeof payload === "string" ? payload : JSON.stringify(payload),
      })
    );
  }

  fail(error = new Error("socket failed")) {
    this.dispatchEvent(
      new ErrorEvent("error", { error, message: error.message })
    );
  }

  send(payload) {
    this.sent.push(payload);
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close"));
  }
}
FakeWebSocket.instances = [];

function setupBrowserGlobals() {
  FakeWebSocket.instances = [];
  globalThis.window = new FakeWindow();
  globalThis.window.location = {
    protocol: "http:",
    host: "localhost:3000",
    origin: "http://localhost:3000",
  };
  globalThis.window.localStorage = {
    getItem: (key) => (key === "auth-token" ? "jwt-secret" : null),
  };
  globalThis.CustomEvent =
    globalThis.CustomEvent ||
    class CustomEvent extends Event {
      constructor(type, options = {}) {
        super(type, options);
        this.detail = options.detail;
      }
    };
  globalThis.MessageEvent =
    globalThis.MessageEvent ||
    class MessageEvent extends Event {
      constructor(type, options = {}) {
        super(type, options);
        this.data = options.data;
      }
    };
  globalThis.ErrorEvent =
    globalThis.ErrorEvent ||
    class ErrorEvent extends Event {
      constructor(type, options = {}) {
        super(type, options);
        this.error = options.error;
        this.message = options.message;
      }
    };
  globalThis.CloseEvent =
    globalThis.CloseEvent ||
    class CloseEvent extends Event {
      constructor(type, options = {}) {
        super(type, options);
        this.code = options.code || 1000;
        this.reason = options.reason || "";
      }
    };
  globalThis.WebSocket = FakeWebSocket;
}

async function loadAgentClient() {
  setupBrowserGlobals();
  globalThis.__agentWsRequestJson = async () => ({
    data: {
      success: true,
      state: {
        provider: "debug",
        model: "debug-model",
        modelTier: "debug",
        silenceTimeoutMs: 60_000,
      },
    },
  });

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "agent-ws-client-"));
  const protocolSource = await readFile(protocolUrl, "utf8");
  await writeFile(
    path.join(tmpDir, "agentWebSocketProtocol.js"),
    protocolSource
      .replace(
        /import\s+\{\s*dispatchThreadRename\s*\}\s+from\s+"@\/utils\/chat";/,
        "const dispatchThreadRename = () => {};"
      )
      .replace(
        /import\s+\{\s*debugChatTurn\s*\}\s+from\s+"@\/utils\/chat\/debug";/,
        "const debugChatTurn = () => {};"
      )
      .replace(
        /import\s+\{\s*safeJsonParse\s*\}\s+from\s+"@\/utils\/request";/,
        "const safeJsonParse = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };"
      ),
    "utf8"
  );
  await writeFile(
    path.join(tmpDir, "webSocketClient.js"),
    `export function createWebSocket({ url } = {}) { return new WebSocket(url); }
export function safeSendJson(socket, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return { ok: false, reason: "not_open" };
  socket.send(JSON.stringify(payload));
  return { ok: true };
}
export function safeClose(socket) { socket?.close?.(); }`,
    "utf8"
  );
  await writeFile(
    path.join(tmpDir, "transportSecurity.js"),
    `export function webSocketOriginForHttpBase(httpBase) {
  const url = new URL(httpBase);
  return \`\${url.protocol === "https:" ? "wss:" : "ws:"}//\${url.host}\`;
}`,
    "utf8"
  );

  const clientSource = await readFile(clientUrl, "utf8");
  await writeFile(
    path.join(tmpDir, "agentWebSocketClient.js"),
    clientSource
      .replace(
        /import\s+\{\s*useEffect,\s*useState\s*\}\s+from\s+"react";/,
        "const useEffect = () => {}; const useState = (value) => [typeof value === 'function' ? value() : value, () => {}];"
      )
      .replace(
        /import\s+\{\s*API_BASE,\s*AUTH_TOKEN\s*\}\s+from\s+"@\/utils\/constants";/,
        'const API_BASE = "/api"; const AUTH_TOKEN = "auth-token";'
      )
      .replace(
        /import\s+\{[\s\S]*?\}\s+from\s+"@\/utils\/codexDevAuthBypass";/,
        'const CODEX_DEV_AUTH_BYPASS_KEY = "dev-key"; const CODEX_DEV_AUTH_BYPASS_QUERY = "codexDevAuthBypass"; const isCodexDevAuthBypassEnabled = () => false;'
      )
      .replace(
        /import\s+\{\s*requestJson\s*\}\s+from\s+"\.\/apiClient";/,
        "const requestJson = (...args) => globalThis.__agentWsRequestJson(...args);"
      )
      .replaceAll('from "./webSocketClient"', 'from "./webSocketClient.js"')
      .replaceAll('from "./transportSecurity"', 'from "./transportSecurity.js"')
      .replaceAll(
        'from "./agentWebSocketProtocol"',
        'from "./agentWebSocketProtocol.js"'
      )
      .replaceAll(
        "import.meta.env.VITE_API_BASE",
        '"http://localhost:3002/api"'
      ),
    "utf8"
  );

  const mod = await import(
    `${pathToFileURL(path.join(tmpDir, "agentWebSocketClient.js")).href}?${Date.now()}`
  );
  return { mod, tmpDir };
}

function reportFinal(content, seq = 1, extra = {}) {
  return {
    type: "reportStreamEvent",
    content: {
      type: "fullTextResponse",
      seq,
      content,
      chatId: 123,
      publicChatId: "chat_debug",
      close: true,
      ...extra,
    },
  };
}

test("Agent session ignores duplicate final and blocks reconnect/feedback after close", async () => {
  const { mod, tmpDir } = await loadAgentClient();
  try {
    const events = [];
    const finals = [];
    const states = [];
    const controller = mod.createAgentWebSocketSession({
      websocketUUID: "debug-final",
      onEvent: (event) => {
        events.push(event);
        return event;
      },
      onFinal: (...args) => finals.push(args),
      onState: (state) => states.push(state),
    });

    const socket = FakeWebSocket.instances.at(-1);
    socket.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.message(reportFinal("done", 1));
    socket.message(reportFinal("duplicate", 1));
    socket.close();

    assert.equal(finals.length, 1);
    assert.equal(
      events.filter((event) => event.type === "assistant_final").length,
      1
    );
    assert.equal(controller.reconnect("after_final"), false);
    assert.deepEqual(controller.sendFeedback({ feedback: "nope" }), {
      ok: false,
      reason: mod.AgentSessionState.CLOSED,
    });
    assert.equal(controller.getState().state, mod.AgentSessionState.CLOSED);
    assert(
      states.some((state) => state.state === mod.AgentSessionState.FINALIZED)
    );
    controller.close("test_cleanup");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Agent stop emits one stop and suppresses close/error assistant errors", async () => {
  const { mod, tmpDir } = await loadAgentClient();
  try {
    const events = [];
    const errors = [];
    const closes = [];
    const controller = mod.createAgentWebSocketSession({
      websocketUUID: "debug-stop",
      onEvent: (event) => {
        events.push(event);
        return event;
      },
      onError: (...args) => errors.push(args),
      onClose: (...args) => closes.push(args),
    });

    const socket = FakeWebSocket.instances.at(-1);
    socket.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(controller.stop("test_stop"), { ok: true });
    socket.fail(new Error("late failure"));
    socket.close();
    assert.equal(
      events.filter((event) => event.type === "stop_generation").length,
      1
    );
    assert.equal(
      events.filter((event) => event.type === "assistant_error").length,
      0
    );
    assert.equal(errors.length, 0);
    assert(closes.length >= 1);
    assert.equal(controller.getState().state, mod.AgentSessionState.CLOSED);
    controller.close("test_cleanup");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Agent waiting_on_input allows clarification and is not terminal", async () => {
  const { mod, tmpDir } = await loadAgentClient();
  try {
    const states = [];
    const controller = mod.createAgentWebSocketSession({
      websocketUUID: "debug-waiting",
      onState: (state) => states.push(state),
    });

    const socket = FakeWebSocket.instances.at(-1);
    socket.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.message({ type: "WAITING_ON_INPUT", seq: 1, question: "continue?" });
    assert.equal(
      controller.getState().state,
      mod.AgentSessionState.WAITING_ON_INPUT
    );
    assert.equal(
      controller.respondToClarification("q1", {
        answers: [{ id: "q1", answer: "yes" }],
      }).ok,
      true
    );
    assert.equal(controller.getState().state, mod.AgentSessionState.OPEN);
    assert(
      states.some(
        (state) => state.state === mod.AgentSessionState.WAITING_ON_INPUT
      )
    );
    controller.close("test_cleanup");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
