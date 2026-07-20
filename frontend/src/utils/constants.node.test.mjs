import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";

const constantsUrl = new URL("./constants.js", import.meta.url);

async function loadConstants({ apiBase, pageUrl, dev = true } = {}) {
  const source = await readFile(constantsUrl, "utf8");
  globalThis.window = {
    location: new URL(pageUrl),
  };

  const transformed = source
    .replaceAll("import.meta.env?.VITE_API_BASE", JSON.stringify(apiBase ?? ""))
    .replaceAll("import.meta.env.VITE_API_BASE", JSON.stringify(apiBase ?? ""))
    .replaceAll("import.meta.env?.DEV", String(dev))
    .replaceAll("import.meta.env.DEV", String(dev));

  return import(
    `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${Date.now()}-${Math.random()}`
  );
}

test("localhost page rewrites stale LAN API base to localhost", async () => {
  const mod = await loadConstants({
    pageUrl: "http://localhost:3000/",
    apiBase: "http://192.168.2.181:3002/api",
  });

  assert.equal(mod.API_BASE, "http://localhost:3002/api");
});

test("LAN page rewrites stale LAN API base to current LAN host", async () => {
  const mod = await loadConstants({
    pageUrl: "http://192.168.0.104:3000/",
    apiBase: "http://192.168.2.181:3002/api",
  });

  assert.equal(mod.API_BASE, "http://192.168.0.104:3002/api");
});

test("LAN page rewrites localhost API base to current LAN host", async () => {
  const mod = await loadConstants({
    pageUrl: "http://192.168.0.104:3000/",
    apiBase: "http://localhost:3002/api",
  });

  assert.equal(mod.API_BASE, "http://192.168.0.104:3002/api");
});

test("public API hosts are not rewritten", async () => {
  const mod = await loadConstants({
    pageUrl: "http://localhost:3000/",
    apiBase: "https://api.example.com/api",
  });

  assert.equal(mod.API_BASE, "https://api.example.com/api");
});

test("production mode does not rewrite private LAN API hosts", async () => {
  const mod = await loadConstants({
    pageUrl: "http://localhost:3000/",
    apiBase: "http://192.168.2.181:3002/api",
    dev: false,
  });

  assert.equal(mod.API_BASE, "http://192.168.2.181:3002/api");
});
