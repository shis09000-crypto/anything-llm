import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import * as apiError from "./apiError.js";

const transportSecurityUrl = new URL("./transportSecurity.js", import.meta.url);

async function loadTransportSecurity({ prod = false } = {}) {
  const source = await readFile(transportSecurityUrl, "utf8");
  globalThis.__transportSecurityTestApiError = apiError;

  const transformed = source
    .replace(
      'import { API_ERROR_CODES, createApiError } from "./apiError";',
      "const { API_ERROR_CODES, createApiError } = globalThis.__transportSecurityTestApiError;"
    )
    .replaceAll("import.meta.env.PROD", String(prod));

  return import(
    `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${Date.now()}-${Math.random()}`
  );
}

function installWindow(origin) {
  globalThis.window = {
    location: new URL(origin),
  };
}

test("production HTTP guard rejects insecure Athena API URLs", async () => {
  installWindow("https://athena.example.com/");
  const mod = await loadTransportSecurity({ prod: true });

  assert.equal(
    mod.assertSecureHttpUrl("https://api.example.com/api", { kind: "api" }),
    "https://api.example.com/api"
  );
  assert.throws(
    () =>
      mod.assertSecureHttpUrl("http://api.example.com/api", { kind: "api" }),
    (error) =>
      error.code === apiError.API_ERROR_CODES.TRANSPORT_SECURITY_ERROR &&
      error.details?.protocol === "http:"
  );
});

test("production relative URLs inherit the browser protocol", async () => {
  installWindow("https://athena.example.com/");
  const secure = await loadTransportSecurity({ prod: true });
  assert.equal(secure.assertSecureHttpUrl("/api/ping"), "/api/ping");

  installWindow("http://athena.example.com/");
  const insecure = await loadTransportSecurity({ prod: true });
  assert.throws(
    () => insecure.assertSecureHttpUrl("/api/ping"),
    (error) => error.code === apiError.API_ERROR_CODES.TRANSPORT_SECURITY_ERROR
  );
});

test("production WebSocket guard allows wss and rejects ws", async () => {
  installWindow("https://athena.example.com/");
  const mod = await loadTransportSecurity({ prod: true });

  assert.equal(
    mod.webSocketOriginForHttpBase("https://api.example.com/api", {
      kind: "agent_websocket",
    }),
    "wss://api.example.com"
  );
  assert.throws(
    () =>
      mod.webSocketOriginForHttpBase("http://api.example.com/api", {
        kind: "agent_websocket",
      }),
    (error) =>
      error.code === apiError.API_ERROR_CODES.TRANSPORT_SECURITY_ERROR &&
      error.details?.protocol === "ws:"
  );
});

test("development keeps localhost HTTP and WS behavior available", async () => {
  installWindow("http://localhost:3000/");
  const mod = await loadTransportSecurity({ prod: false });

  assert.equal(mod.isLocalhostLike("localhost"), true);
  assert.equal(
    mod.assertSecureHttpUrl("http://localhost:3002/api"),
    "http://localhost:3002/api"
  );
  assert.equal(
    mod.webSocketOriginForHttpBase("http://localhost:3002/api"),
    "ws://localhost:3002"
  );
});
