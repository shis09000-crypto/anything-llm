#!/usr/bin/env node
/* global console, process, TextEncoder, fetch, window, indexedDB */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1] || fallback;
  return fallback;
}

function hasArg(name) {
  return process.argv.includes(`--${name}`);
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    /* noop */
  }
  try {
    return await import("playwright-core");
  } catch {
    /* noop */
  }
  const fallbackNodeModuleDirs = [
    process.env.ATHENA_PLAYWRIGHT_NODE_MODULES,
    path.join(
      os.homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules"
    ),
  ].filter(Boolean);
  for (const dir of fallbackNodeModuleDirs) {
    try {
      return await import(
        pathToFileURL(path.join(dir, "playwright", "index.mjs")).href
      );
    } catch {
      /* noop */
    }
    try {
      return await import(
        pathToFileURL(path.join(dir, "playwright-core", "index.mjs")).href
      );
    } catch {
      /* noop */
    }
    try {
      return await import(
        pathToFileURL(path.join(dir, "playwright", "index.js")).href
      );
    } catch {
      /* noop */
    }
    try {
      return await import(
        pathToFileURL(path.join(dir, "playwright-core", "index.js")).href
      );
    } catch {
      /* noop */
    }
  }
  throw new Error(
    "Playwright is not installed. Install it locally or run this script from an environment that provides playwright."
  );
}

const baseUrl = argValue("base-url", "https://localhost:3000").replace(
  /\/$/,
  ""
);
const email =
  argValue("email") || process.env.ATHENA_TEST_EMAIL || process.env.EMAIL || "";
const password =
  argValue("password") ||
  process.env.ATHENA_TEST_PASSWORD ||
  process.env.PASSWORD ||
  "";
const outPath = argValue("out");
const headless = argValue("headed", "false") !== "true";
const executablePath = argValue("executable-path");
const allowUnauthenticated = hasArg("allow-unauthenticated");
const requestedPaths = String(argValue("paths", "") || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

function defaultChromeExecutablePath() {
  if (process.platform === "darwin") {
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(
        os.homedir(),
        "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      ),
    ];
    return candidates.find((candidate) => {
      try {
        return Boolean(candidate && fsSync.existsSync(candidate));
      } catch {
        /* noop */
        return false;
      }
    });
  }
  return null;
}

const AUTH_TOKEN_KEY = "anythingllm_authToken";
const AUTH_USER_KEY = "anythingllm_user";
const LEGACY_PROMPT_DRAFT_KEY = "anythingllm_user_prompt_input_map";
const THREAD_HISTORY_PREFIX = "workspacechat-history:";
const SIGNING_SECRET_PREFIX = "athena_signing_secret_v1:";
const READER_SEALED_VERSION = "athena-reader-local-cache:v1";
const SENSITIVE_USER_FIELD_PATTERN =
  /(password|token|secret|api.?key|private.?key|credential|challenge|recovery|totp|mfa|salt|hash|session|jwt|signing)/i;
const READER_SENSITIVE_KEYS = new Set([
  "anythingllm_document_reader:v1:global",
  "anythingllm_document_reader_sources:v1:global",
  "anythingllm_document_reader_history:v1:global",
  "anythingllm_document_reader_bookshelf:v1",
  "anythingllm_document_reader_bookshelf_categories:v1",
  "anythingllm_document_reader_book_memory:v1",
]);

function safeJson(raw, fallback = null) {
  try {
    if (raw === null || raw === undefined) return fallback;
    return JSON.parse(raw);
  } catch {
    /* noop */
  }
  return fallback;
}

function isEmptyObject(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function isSealedReaderValue(raw) {
  const parsed = safeJson(raw, null);
  return (
    parsed?.sealed === READER_SEALED_VERSION &&
    parsed?.encryptedPayload?.encrypted === true
  );
}

function isSealedThreadHistoryValue(raw) {
  const parsed = safeJson(raw, null);
  return (
    parsed?.encrypted === true &&
    parsed?.encryptedPayload?.encrypted === true &&
    parsed?.payload === null
  );
}

function collectSensitiveKeys(value, prefix = "", keys = []) {
  if (!value || typeof value !== "object") return keys;
  for (const [key, nested] of Object.entries(value)) {
    const nextPath = prefix ? `${prefix}.${key}` : key;
    if (SENSITIVE_USER_FIELD_PATTERN.test(key)) keys.push(nextPath);
    if (nested && typeof nested === "object") {
      collectSensitiveKeys(nested, nextPath, keys);
    }
  }
  return keys;
}

function summarizeStorage(entries = {}) {
  return Object.fromEntries(
    Object.entries(entries).map(([key, value]) => [
      key,
      {
        byteLength: new TextEncoder().encode(String(value || "")).length,
        json: Boolean(safeJson(value, null)),
      },
    ])
  );
}

async function loginInBrowser(page) {
  if (!email || !password) {
    if (allowUnauthenticated) return null;
    throw new Error(
      "Missing ATHENA_TEST_EMAIL/ATHENA_TEST_PASSWORD. Pass --allow-unauthenticated to run a public-page-only storage audit."
    );
  }

  const payload = await page.evaluate(
    async ({ email, password }) => {
      const response = await fetch("/api/request-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: email, password }),
      });
      return {
        status: response.status,
        data: await response.json().catch(() => null),
      };
    },
    { email, password }
  );

  if (!payload.data?.valid || !payload.data?.token) {
    throw new Error(`Login failed with status ${payload.status}.`);
  }

  await page.evaluate(({ token, user }) => {
    window.localStorage.removeItem("anythingllm_authToken");
    window.localStorage.removeItem("anythingllm_user");
    window.sessionStorage.setItem("anythingllm_authToken", token);
    window.sessionStorage.setItem("anythingllm_user", JSON.stringify(user));
  }, payload.data);

  return payload.data;
}

async function collectRuntimeSnapshot(page) {
  return await page.evaluate(async () => {
    function storageEntries(storage) {
      const entries = {};
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (!key) continue;
        entries[key] = storage.getItem(key);
      }
      return entries;
    }

    function summarizeIdbValue(value) {
      const encrypted =
        value?.encrypted === true &&
        value?.encryptedPayload?.encrypted === true;
      return {
        key: value?.key || value?.id || null,
        encrypted,
        hasPayload: value?.payload !== null && value?.payload !== undefined,
        hasEncryptedPayload: value?.encryptedPayload?.encrypted === true,
      };
    }

    async function inspectDb(name) {
      return await new Promise((resolve) => {
        const request = indexedDB.open(name);
        request.onerror = () =>
          resolve({ name, available: false, error: "open_failed" });
        request.onsuccess = () => {
          const db = request.result;
          const stores = [];
          const storeNames = Array.from(db.objectStoreNames || []);
          let pending = storeNames.length;
          if (!pending) {
            db.close();
            resolve({ name, stores });
            return;
          }

          for (const storeName of storeNames) {
            const tx = db.transaction(storeName, "readonly");
            const store = tx.objectStore(storeName);
            const getAll = store.getAll();
            getAll.onsuccess = () => {
              const values = getAll.result || [];
              stores.push({
                name: storeName,
                count: values.length,
                samples: values.slice(0, 10).map(summarizeIdbValue),
                insecureHistoryEntries:
                  storeName === "history"
                    ? values.filter(
                        (value) =>
                          !(
                            value?.encrypted === true &&
                            value?.encryptedPayload?.encrypted === true &&
                            value?.payload === null
                          )
                      ).length
                    : 0,
              });
            };
            getAll.onerror = () => {
              stores.push({ name: storeName, available: false });
            };
            tx.oncomplete = () => {
              pending -= 1;
              if (pending === 0) {
                db.close();
                resolve({ name, stores });
              }
            };
            tx.onerror = () => {
              pending -= 1;
              if (pending === 0) {
                db.close();
                resolve({ name, stores });
              }
            };
          }
        };
      });
    }

    const indexedDbNames =
      typeof indexedDB.databases === "function"
        ? (await indexedDB.databases()).map((db) => db.name).filter(Boolean)
        : [];
    const indexedDb = [];
    for (const name of indexedDbNames) {
      if (!/workspacechat-cache|athena|anythingllm/i.test(name)) continue;
      indexedDb.push(await inspectDb(name));
    }

    return {
      location: window.location.href,
      localStorage: storageEntries(window.localStorage),
      sessionStorage: storageEntries(window.sessionStorage),
      indexedDb,
    };
  });
}

function analyzeSnapshot(snapshot) {
  const findings = [];
  const localStorage = snapshot.localStorage || {};
  const sessionStorage = snapshot.sessionStorage || {};

  if (localStorage[AUTH_TOKEN_KEY]) {
    findings.push({
      severity: "high",
      area: "auth",
      key: AUTH_TOKEN_KEY,
      storage: "localStorage",
      message: "Auth token must not be stored in localStorage.",
    });
  }

  if (localStorage[AUTH_USER_KEY]) {
    findings.push({
      severity: "high",
      area: "auth",
      key: AUTH_USER_KEY,
      storage: "localStorage",
      message: "Auth user cache must not be stored in localStorage.",
    });
  }

  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(SIGNING_SECRET_PREFIX)) {
      findings.push({
        severity: "high",
        area: "request-signing",
        key,
        storage: "localStorage",
        message: "Request signing secret must not be stored in localStorage.",
      });
    }
  }

  const sessionUser = safeJson(sessionStorage[AUTH_USER_KEY], null);
  const sensitiveUserKeys = collectSensitiveKeys(sessionUser);
  if (sensitiveUserKeys.length) {
    findings.push({
      severity: "high",
      area: "auth",
      key: AUTH_USER_KEY,
      storage: "sessionStorage",
      message: "Stored auth user contains sensitive fields.",
      fields: sensitiveUserKeys.slice(0, 10),
    });
  }

  const promptMap = safeJson(localStorage[LEGACY_PROMPT_DRAFT_KEY], null);
  if (promptMap && !isEmptyObject(promptMap)) {
    findings.push({
      severity: "high",
      area: "draft-cache",
      key: LEGACY_PROMPT_DRAFT_KEY,
      storage: "localStorage",
      message: "Legacy prompt draft localStorage map still contains values.",
    });
  }

  for (const key of READER_SENSITIVE_KEYS) {
    const raw = localStorage[key];
    if (raw === null || raw === undefined) continue;
    if (!isSealedReaderValue(raw)) {
      findings.push({
        severity: "high",
        area: "reader-cache",
        key,
        storage: "localStorage",
        message: "Reader sensitive local cache must be sealed.",
      });
    }
  }

  for (const [key, raw] of Object.entries(sessionStorage)) {
    if (!key.startsWith(THREAD_HISTORY_PREFIX)) continue;
    if (!isSealedThreadHistoryValue(raw)) {
      findings.push({
        severity: "high",
        area: "thread-history-cache",
        key,
        storage: "sessionStorage",
        message: "Thread history session cache must be sealed.",
      });
    }
  }

  for (const db of snapshot.indexedDb || []) {
    if (!/workspacechat-cache/i.test(db.name || "")) continue;
    for (const store of db.stores || []) {
      if (store.name !== "history") continue;
      if (Number(store.insecureHistoryEntries || 0) > 0) {
        findings.push({
          severity: "high",
          area: "thread-history-cache",
          storage: "indexedDB",
          database: db.name,
          store: store.name,
          message: "IndexedDB thread history entries must be sealed.",
          insecureEntries: store.insecureHistoryEntries,
        });
      }
    }
  }

  return findings;
}

async function fetchFirstWorkspacePath(page) {
  const payload = await page.evaluate(async () => {
    const token = window.sessionStorage.getItem("anythingllm_authToken");
    if (!token) return null;
    const response = await fetch("/api/workspaces", {
      headers: { Authorization: `Bearer ${token}` },
    });
    return await response.json().catch(() => null);
  });
  const workspace = payload?.workspaces?.[0];
  if (!workspace?.slug) return null;
  const firstThread = (workspace.threads || []).find((thread) => thread?.slug);
  return firstThread?.slug
    ? `/workspace/${workspace.slug}/t/${firstThread.slug}`
    : `/workspace/${workspace.slug}`;
}

async function main() {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({
    headless,
    executablePath:
      executablePath || defaultChromeExecutablePath() || undefined,
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);

  const visited = [];
  let authenticated = false;
  let snapshot;

  try {
    await page.goto(`${baseUrl}/login?nt=1`, { waitUntil: "domcontentloaded" });
    const login = await loginInBrowser(page);
    authenticated = Boolean(login?.token);

    const paths = requestedPaths.length
      ? requestedPaths
      : [
          authenticated ? await fetchFirstWorkspacePath(page) : null,
          "/settings/interface",
        ].filter(Boolean);

    for (const path of paths) {
      await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded" });
      visited.push(path);
      await page.waitForTimeout(1_200).catch(() => {});
    }

    snapshot = await collectRuntimeSnapshot(page);
  } finally {
    await browser.close();
  }

  const findings = analyzeSnapshot(snapshot);
  const highRiskFindings = findings.filter(
    (finding) => finding.severity === "high"
  );
  const report = {
    success: highRiskFindings.length === 0,
    generatedAt: new Date().toISOString(),
    baseUrl,
    authenticated,
    visited,
    summary: {
      localStorageKeys: Object.keys(snapshot.localStorage || {}).length,
      sessionStorageKeys: Object.keys(snapshot.sessionStorage || {}).length,
      indexedDbCount: snapshot.indexedDb?.length || 0,
      findings: findings.length,
      highRiskFindings: highRiskFindings.length,
    },
    storageShape: {
      localStorage: summarizeStorage(snapshot.localStorage),
      sessionStorage: summarizeStorage(snapshot.sessionStorage),
      indexedDb: snapshot.indexedDb,
    },
    findings,
  };

  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (outPath) await fs.writeFile(outPath, output, "utf8");
  process.stdout.write(output);
  process.exit(report.success ? 0 : 1);
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      { success: false, error: error?.message || String(error) },
      null,
      2
    )
  );
  process.exit(1);
});
