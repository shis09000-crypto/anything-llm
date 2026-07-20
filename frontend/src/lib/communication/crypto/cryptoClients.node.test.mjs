import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";

const cryptoSharedUrl = new URL("./cryptoShared.js", import.meta.url);
const cryptoHubClientUrl = new URL("./cryptoHubClient.js", import.meta.url);
const cryptoHubStreamClientUrl = new URL(
  "./cryptoHubStreamClient.js",
  import.meta.url
);

async function importSource(source) {
  return import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${Date.now()}-${Math.random()}`
  );
}

async function loadCryptoShared({ prod = false, dev = true } = {}) {
  const source = await readFile(cryptoSharedUrl, "utf8");
  const transformed = source
    .replace(
      'import { API_BASE, fullApiUrl } from "@/utils/constants";',
      'const API_BASE = "/api"; const fullApiUrl = () => "http://localhost:3002/api";'
    )
    .replace(
      'import { getAuthToken } from "@/utils/authTokenStorage";',
      "const getAuthToken = () => globalThis.__cryptoClientTestToken || null;"
    )
    .replace(
      'import { assertSecureWebSocketUrl } from "../transportSecurity";',
      "const assertSecureWebSocketUrl = (url) => url;"
    )
    .replaceAll("import.meta.env.PROD", String(prod))
    .replaceAll("import.meta.env.DEV", String(dev));
  return importSource(transformed);
}

async function loadCryptoHubClient() {
  const source = await readFile(cryptoHubClientUrl, "utf8");
  const transformed = source
    .replace(
      'import { requestJson } from "../apiClient";',
      "const requestJson = (...args) => globalThis.__cryptoClientTest.requestJson(...args);"
    )
    .replace(
      /import \{[\s\S]*?\} from "\.\/cryptoShared";/,
      `const {
        CRYPTO_HUB_BASE,
        cryptoDevLog,
        cryptoError,
        cryptoHubPath,
        cryptoPayloadError,
        cryptoRequestHeaders,
        durationSince,
        nowMs,
      } = globalThis.__cryptoClientTest.shared;`
    );
  return importSource(transformed);
}

async function loadCryptoHubStreamClient() {
  const source = await readFile(cryptoHubStreamClientUrl, "utf8");
  const transformed = source
    .replace(
      'import { getJsonSse } from "../streamClient";',
      "const getJsonSse = (...args) => globalThis.__cryptoClientTest.getJsonSse(...args);"
    )
    .replace(
      'import { cryptoHubPath, cryptoRequestHeaders } from "./cryptoShared";',
      "const { cryptoHubPath, cryptoRequestHeaders } = globalThis.__cryptoClientTest.shared;"
    );
  return importSource(transformed);
}

function installWindow({ search = "", token = "jwt-secret" } = {}) {
  globalThis.__cryptoClientTestToken = token;
  globalThis.window = {
    location: { search },
    localStorage: {},
  };
}

test("crypto shared keeps dev bypass scoped and uses one-time realtime tickets", async () => {
  installWindow({ search: "?cryptoCenterAuthBypass=1", token: "jwt-secret" });
  const shared = await loadCryptoShared({ prod: false });

  assert.equal(shared.cryptoDevBypassActive(), true);
  assert.deepEqual(
    shared.cryptoRequestHeaders({ Accept: "application/json" }),
    {
      "x-crypto-center-dev-auth-bypass": "1",
      Accept: "application/json",
    }
  );
  const url = new URL(shared.cryptoCenterStreamUrl("24h", "rt-one-time"));
  assert.equal(url.protocol, "ws:");
  assert.equal(url.searchParams.get("range"), "24h");
  assert.equal(url.searchParams.get("token"), null);
  assert.equal(url.searchParams.get("realtimeTicket"), "rt-one-time");
  assert.equal(url.searchParams.get("cryptoCenterAuthBypass"), "1");

  const prodShared = await loadCryptoShared({ prod: true });
  assert.equal(prodShared.cryptoDevBypassActive(), false);
  assert.deepEqual(prodShared.cryptoRequestHeaders(), {});
});

test("cryptoHubFetch returns payloads and maps success false to safe errors", async () => {
  const shared = await loadCryptoShared();
  const logs = [];
  globalThis.__cryptoClientTest = {
    shared: {
      ...shared,
      cryptoDevLog: (phase, metadata) => logs.push({ phase, metadata }),
    },
    requestJson: async () => ({
      response: { status: 200 },
      data: { success: true, value: 42 },
      requestId: "request-1",
    }),
  };

  const { cryptoHubFetch } = await loadCryptoHubClient();
  assert.deepEqual(await cryptoHubFetch("/status"), {
    success: true,
    value: 42,
  });
  assert.equal(logs[0].metadata.requestId, "request-1");

  globalThis.__cryptoClientTest.requestJson = async () => ({
    response: { status: 200 },
    data: { success: false, safeErrorMessage: "safe failure" },
    requestId: "request-2",
  });
  await assert.rejects(
    cryptoHubFetch("/status"),
    (error) => error.message === "safe failure"
  );
  assert.equal(logs.at(-1).phase, "failure");
  assert.equal(logs.at(-1).metadata.requestId, "request-2");
});

test("cryptoHubFetch singleflights concurrent hub GETs and init POSTs", async () => {
  const shared = await loadCryptoShared();
  let releaseRequest = () => {};
  let requestGate = new Promise((resolve) => {
    releaseRequest = resolve;
  });
  const calls = [];
  globalThis.__cryptoClientTest = {
    shared,
    requestJson: async (path, options = {}) => {
      calls.push({ path, method: options.method || "GET" });
      await requestGate;
      return {
        response: { status: 200 },
        data: {
          success: true,
          path,
          method: options.method || "GET",
          callCount: calls.length,
        },
        requestId: `request-${calls.length}`,
      };
    },
  };

  const { cryptoHubFetch, cryptoHubPost } = await loadCryptoHubClient();
  const firstGet = cryptoHubFetch("/allocation");
  const secondGet = cryptoHubFetch("/allocation");
  await Promise.resolve();
  assert.equal(calls.length, 1);
  releaseRequest();
  assert.deepEqual(await firstGet, await secondGet);
  assert.equal(calls.length, 1);

  const warmGet = await cryptoHubFetch("/allocation");
  assert.equal(warmGet.callCount, 1);
  assert.equal(calls.length, 1);

  requestGate = new Promise((resolve) => {
    releaseRequest = resolve;
  });
  const firstInit = cryptoHubPost("/init");
  const secondInit = cryptoHubPost("/init");
  await Promise.resolve();
  assert.equal(calls.length, 2);
  releaseRequest();
  assert.deepEqual(await firstInit, await secondInit);
  assert.equal(calls.at(-1).path, "/crypto-hub/init");
});

test("cryptoHub stream preserves envelopes and ignores heartbeat/status payloads", async () => {
  const shared = await loadCryptoShared();
  const events = [];
  let receivedOptions;
  globalThis.__cryptoClientTest = {
    shared,
    getJsonSse: async (options) => {
      receivedOptions = options;
      options.onMessage({ type: "heartbeat", topic: "positions", data: {} });
      options.onMessage({ type: "status", topic: "positions", data: {} });
      options.onMessage({
        type: "snapshot",
        topic: "positions",
        data: { success: true, rows: [1] },
      });
      options.onMessage({ success: true, rows: [2] });
    },
  };

  const { streamOpenFuturesPositions } = await loadCryptoHubStreamClient();
  await streamOpenFuturesPositions({
    onData: (data, envelope) => events.push({ data, envelope }),
  });

  assert.equal(
    receivedOptions.path,
    "/crypto-hub/open-futures-positions/stream"
  );
  assert.equal(receivedOptions.openWhenHidden, false);
  assert.deepEqual(
    events.map((event) => event.data),
    [
      { success: true, rows: [1] },
      { success: true, rows: [2] },
    ]
  );
  assert.equal(events[0].envelope.type, "snapshot");
  assert.equal(events[1].envelope.topic, "legacy");
});
