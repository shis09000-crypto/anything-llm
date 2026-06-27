import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";

const clientIdentityUrl = new URL("./clientIdentity.js", import.meta.url);
const clientCapabilityProfileUrl = new URL(
  "./clientCapabilityProfile.js",
  import.meta.url
);

function memoryStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };
}

async function loadClientIdentity({
  apiBase = "/api",
  platform = "",
  appVersion = "1.9.2-test",
  gitSha = "",
} = {}) {
  const source = await readFile(clientIdentityUrl, "utf8");
  const capabilitySource = await readFile(clientCapabilityProfileUrl, "utf8");
  globalThis.__clientIdentityTestCapability = await import(
    `data:text/javascript;base64,${Buffer.from(capabilitySource).toString("base64")}#capability-${Date.now()}-${Math.random()}`
  );
  const transformed = source
    .replace(
      'import { API_BASE } from "@/utils/constants";',
      `const API_BASE = ${JSON.stringify(apiBase)};`
    )
    .replace(
      /import\s+\{[\s\S]*?\}\s+from\s+"\.\/clientCapabilityProfile";/,
      "const { ATHENA_CAPABILITY_PROFILE_HEADER, ATHENA_CAPABILITY_PROFILE_QUERY, ATHENA_CAPABILITY_SOURCE_HEADER, encodeCapabilityProfile, getClientCapabilityProfile } = globalThis.__clientIdentityTestCapability;"
    )
    .replaceAll(
      "import.meta.env.VITE_ATHENA_PLATFORM",
      JSON.stringify(platform)
    )
    .replaceAll("import.meta.env.VITE_APP_VERSION", JSON.stringify(appVersion))
    .replaceAll("import.meta.env.VITE_GIT_SHA", JSON.stringify(gitSha));

  return import(
    `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${Date.now()}-${Math.random()}`
  );
}

test("client identity generates a stable web client id and headers", async () => {
  const originalWindow = globalThis.window;
  globalThis.window = {
    localStorage: memoryStorage(),
    location: {
      href: "https://athena.example.com/workspace",
      origin: "https://athena.example.com",
    },
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 2,
    matchMedia: (query) => ({
      matches:
        query.includes("hover: hover") || query.includes("pointer: fine"),
    }),
    document: { createElement: () => ({}) },
    Notification: function Notification() {},
    navigator: {
      userAgent: "Mozilla/5.0",
      platform: "MacIntel",
      maxTouchPoints: 0,
      clipboard: { writeText: async () => {} },
      mediaDevices: { getUserMedia: async () => {} },
    },
  };

  try {
    const mod = await loadClientIdentity();
    const first = mod.getOrCreateClientId();
    const second = mod.getOrCreateClientId();
    assert.equal(first, second);
    assert.match(first, /^client_/);

    const headers = mod.clientIdentityHeaders({ requestId: "req-1" });
    assert.equal(headers["X-Athena-Client-Id"], first);
    assert.equal(headers["X-Athena-Platform"], "web");
    assert.equal(headers["X-Athena-App-Version"], "1.9.2-test");
    assert.equal(headers["X-Athena-Request-Id"], "req-1");
    assert.equal(headers["X-Athena-Capability-Source"], "detected");
    assert.ok(headers["X-Athena-Capability-Profile"]);

    const identity = mod.getClientIdentity();
    assert.equal(identity.capabilitySource, "detected");
    assert.equal(identity.capabilityProfile.viewport.width, 1440);
    assert.equal(identity.capabilityProfile.input.pointer, "fine");
    assert.equal(identity.capabilities.profile.surface, "browser");
    assert.equal(identity.capabilities.camera, true);
    assert.equal(identity.capabilities.clipboard, true);
    assert.equal(identity.publicKey, undefined);
    assert.equal(identity.deviceFingerprint, undefined);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("websocket query metadata preserves existing params", async () => {
  const originalWindow = globalThis.window;
  globalThis.window = {
    localStorage: memoryStorage(),
    location: {
      href: "https://athena.example.com",
      origin: "https://athena.example.com",
    },
    innerWidth: 390,
    innerHeight: 844,
    devicePixelRatio: 3,
    matchMedia: (query) => ({
      matches:
        query.includes("pointer: coarse") ||
        query.includes("any-pointer: coarse"),
    }),
    document: { createElement: () => ({}) },
    navigator: {
      userAgent: "Mozilla/5.0 (iPhone)",
      platform: "iPhone",
      maxTouchPoints: 1,
    },
  };

  try {
    const mod = await loadClientIdentity({ platform: "ios" });
    const { url, requestId } = mod.appendClientIdentityQueryParams(
      "wss://athena.example.com/api/agent-invocation/demo?token=abc&resume=1",
      { requestId: "ws-req-1" }
    );
    const parsed = new URL(url);
    assert.equal(requestId, "ws-req-1");
    assert.equal(parsed.searchParams.get("token"), "abc");
    assert.equal(parsed.searchParams.get("resume"), "1");
    assert.equal(parsed.searchParams.get("athenaPlatform"), "ios");
    assert.equal(parsed.searchParams.get("athenaRequestId"), "ws-req-1");
    assert.equal(parsed.searchParams.get("athenaCapabilitySource"), "detected");
    assert.ok(parsed.searchParams.get("athenaCapabilityProfile"));
    assert.match(parsed.searchParams.get("athenaClientId"), /^client_/);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("client identity attachment is limited to Athena URLs", async () => {
  const originalWindow = globalThis.window;
  globalThis.window = {
    localStorage: memoryStorage(),
    location: {
      href: "https://athena.example.com",
      origin: "https://athena.example.com",
    },
    innerWidth: 1024,
    innerHeight: 768,
    devicePixelRatio: 1,
    navigator: {
      userAgent: "Mozilla/5.0",
      platform: "MacIntel",
      maxTouchPoints: 0,
    },
  };

  try {
    const mod = await loadClientIdentity({
      apiBase: "https://athena.example.com/api",
    });
    assert.equal(mod.shouldAttachClientIdentityToUrl("/api/system/logo"), true);
    assert.equal(
      mod.shouldAttachClientIdentityToUrl(
        "https://athena.example.com/api/ping"
      ),
      true
    );
    assert.equal(
      mod.shouldAttachClientIdentityToUrl("https://cdn.example.com/file.png"),
      false
    );
  } finally {
    globalThis.window = originalWindow;
  }
});
