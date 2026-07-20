#!/usr/bin/env node
/* global console, process, fetch, window, performance, URL */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { Buffer } from "node:buffer";
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

const baseUrl = argValue("base-url", "http://localhost:3001").replace(
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
const suppliedToken = argValue("token") || process.env.ATHENA_TEST_TOKEN || "";
const outPath = argValue("out");
const label = argValue("label", "local-production-perf");
const headless = argValue("headed", "false") !== "true";
const executablePath = argValue("executable-path");

const results = {
  label,
  baseUrl,
  startedAt: new Date().toISOString(),
  stages: [],
};

function defaultChromeExecutablePath() {
  if (process.platform !== "darwin") return null;
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
      return false;
    }
  });
}

function byteHeader(headers = {}) {
  const value = Number(headers["content-length"] || headers["Content-Length"]);
  return Number.isFinite(value) ? value : 0;
}

function userFromSuppliedToken(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(String(token).split(".")[1] || "", "base64url").toString(
        "utf8"
      )
    );
    return {
      id: payload.id || payload.userId || null,
      authUserId: payload.authUserId || null,
      username: payload.username || "performance-test",
      role: payload.role || "default",
    };
  } catch {
    return { username: "performance-test", role: "default" };
  }
}

function summarizeResources(resources = []) {
  const relevant = resources.filter((entry) =>
    ["script", "link", "css", "fetch", "xmlhttprequest", "navigation"].includes(
      entry.initiatorType
    )
  );
  return {
    count: relevant.length,
    transferSize: relevant.reduce(
      (sum, entry) => sum + Number(entry.transferSize || 0),
      0
    ),
    encodedBodySize: relevant.reduce(
      (sum, entry) => sum + Number(entry.encodedBodySize || 0),
      0
    ),
    decodedBodySize: relevant.reduce(
      (sum, entry) => sum + Number(entry.decodedBodySize || 0),
      0
    ),
    topResources: relevant
      .map((entry) => ({
        name: entry.name,
        initiatorType: entry.initiatorType,
        duration: Math.round(entry.duration || 0),
        transferSize: Math.round(entry.transferSize || 0),
        encodedBodySize: Math.round(entry.encodedBodySize || 0),
      }))
      .sort((a, b) => b.transferSize - a.transferSize)
      .slice(0, 12),
  };
}

async function collectStage(
  page,
  name,
  fn,
  { allowUnauthenticated = false } = {}
) {
  await page.evaluate(() => {
    window.__anythingCommunication?.clear?.();
    window.__anythingWorkspacePerf?.clear?.();
    performance.clearResourceTimings?.();
  });
  const responses = [];
  const onResponse = (response) => {
    const request = response.request();
    responses.push({
      url: response.url(),
      status: response.status(),
      resourceType: request.resourceType(),
      method: request.method(),
      contentLength: byteHeader(response.headers()),
      fromServiceWorker: response.fromServiceWorker(),
    });
  };
  page.on("response", onResponse);
  const startedAt = Date.now();
  let error = null;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  await page.waitForTimeout(900).catch(() => {});
  page.off("response", onResponse);
  const criticalFailures = responses.filter(
    (response) =>
      response.status >= 400 &&
      !(
        allowUnauthenticated &&
        response.status === 401 &&
        new URL(response.url).pathname.startsWith("/api/")
      ) &&
      ["script", "stylesheet", "document", "fetch", "xhr"].includes(
        response.resourceType
      )
  );
  const effectiveError =
    error?.message ||
    (criticalFailures.length
      ? `Critical HTTP failures: ${criticalFailures
          .map((response) => `${response.status} ${response.url}`)
          .join(", ")}`
      : null);
  const browserSnapshot = await page.evaluate(() => ({
    communication: window.__anythingCommunication?.budget?.() || null,
    perf: window.__anythingWorkspacePerf?.snapshot?.() || null,
    resources: performance.getEntriesByType("resource").map((entry) => ({
      name: entry.name,
      initiatorType: entry.initiatorType,
      duration: entry.duration,
      transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize,
      decodedBodySize: entry.decodedBodySize,
    })),
  }));
  results.stages.push({
    name,
    ok: !effectiveError,
    durationMs: Date.now() - startedAt,
    error: effectiveError,
    criticalFailures,
    responses: {
      count: responses.length,
      bytesFromHeaders: responses.reduce(
        (sum, response) => sum + response.contentLength,
        0
      ),
      top: responses
        .filter((response) =>
          ["script", "stylesheet", "document", "fetch", "xhr"].includes(
            response.resourceType
          )
        )
        .sort((a, b) => b.contentLength - a.contentLength)
        .slice(0, 12),
    },
    resources: summarizeResources(browserSnapshot.resources),
    communication: browserSnapshot.communication,
    perf: browserSnapshot.perf,
  });
}

async function loginInBrowser(page) {
  if (suppliedToken) {
    const data = {
      valid: true,
      token: suppliedToken,
      user: userFromSuppliedToken(suppliedToken),
    };
    await page.evaluate(({ token, user }) => {
      window.sessionStorage.setItem("anythingllm_authToken", token);
      window.localStorage.removeItem("anythingllm_user");
      window.sessionStorage.setItem("anythingllm_user", JSON.stringify(user));
      window.localStorage.setItem("communicationDebugPanel", "false");
      window.localStorage.setItem("workspaceChatPerfDebug", "true");
    }, data);
    return data;
  }
  if (!email || !password) {
    throw new Error("Missing ATHENA_TEST_EMAIL/ATHENA_TEST_PASSWORD.");
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
    window.sessionStorage.setItem("anythingllm_authToken", token);
    window.localStorage.removeItem("anythingllm_user");
    window.sessionStorage.setItem("anythingllm_user", JSON.stringify(user));
    window.localStorage.setItem("communicationDebugPanel", "false");
    window.localStorage.setItem("workspaceChatPerfDebug", "true");
  }, payload.data);
  return payload.data;
}

async function fetchWorkspaces(page, token) {
  const payload = await page.evaluate(async (token) => {
    const response = await fetch("/api/workspaces", {
      headers: { Authorization: `Bearer ${token}` },
    });
    return {
      status: response.status,
      data: await response.json().catch(() => null),
    };
  }, token);
  if (!payload.data?.workspaces?.length) {
    throw new Error(`No workspaces returned with status ${payload.status}.`);
  }
  return payload.data.workspaces;
}

function threadPath(workspace, thread = null) {
  if (thread?.slug) return `/workspace/${workspace.slug}/t/${thread.slug}`;
  return `/workspace/${workspace.slug}`;
}

async function main() {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({
    headless,
    executablePath:
      executablePath || defaultChromeExecutablePath() || undefined,
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  if (suppliedToken) {
    await context.addInitScript(
      ({ token, user }) => {
        window.localStorage.removeItem("anythingllm_authToken");
        window.localStorage.removeItem("anythingllm_user");
        window.sessionStorage.setItem("anythingllm_authToken", token);
        window.sessionStorage.setItem("anythingllm_user", JSON.stringify(user));
      },
      { token: suppliedToken, user: userFromSuppliedToken(suppliedToken) }
    );
  }
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);

  try {
    await collectStage(
      page,
      "login-page",
      async () => {
        await page.goto(`${baseUrl}/login?nt=1`, {
          waitUntil: "domcontentloaded",
        });
      },
      { allowUnauthenticated: true }
    );

    const login = await loginInBrowser(page);
    const workspaces = await fetchWorkspaces(page, login.token);
    const workspace = workspaces[0];
    const threads = (workspace.threads || []).filter((thread) => thread.slug);
    const selectedThreads = threads.slice(0, 5);
    results.workspace = {
      slug: workspace.slug,
      threadCount: threads.length,
      sampledThreadCount: selectedThreads.length,
    };

    await collectStage(page, "workspace-first-thread", async () => {
      await page.goto(
        `${baseUrl}${threadPath(workspace, selectedThreads[0])}`,
        {
          waitUntil: "domcontentloaded",
        }
      );
    });

    await collectStage(page, "switch-five-threads", async () => {
      for (const thread of selectedThreads) {
        await page.goto(`${baseUrl}${threadPath(workspace, thread)}`, {
          waitUntil: "domcontentloaded",
        });
        await page.waitForTimeout(600);
      }
    });

    await collectStage(page, "open-reader-drawer", async () => {
      await page.getByTitle("伴读文档").click();
    });

    await collectStage(page, "open-crypto-center", async () => {
      await page.goto(`${baseUrl}/settings/crypto-center`, {
        waitUntil: "domcontentloaded",
      });
    });
  } finally {
    await browser.close();
  }

  results.finishedAt = new Date().toISOString();
  results.success = results.stages.every(
    (stage) => stage.criticalFailures.length === 0
  );
  const output = `${JSON.stringify(results, null, 2)}\n`;
  if (outPath) await fs.writeFile(outPath, output, "utf8");
  process.stdout.write(output);
  if (!results.success) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
