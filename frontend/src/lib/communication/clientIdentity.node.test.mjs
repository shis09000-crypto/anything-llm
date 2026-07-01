import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";

const clientIdentityUrl = new URL("./clientIdentity.js", import.meta.url);
const clientCapabilityProfileUrl = new URL(
  "./clientCapabilityProfile.js",
  import.meta.url
);
const mobileRuntimeUrl = new URL(
  "../../utils/mobileRuntime.js",
  import.meta.url
);

function memoryStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
}

async function loadClientIdentity({
  apiBase = "/api",
  platform = "",
  appVersion = "1.9.2-test",
  gitSha = "",
} = {}) {
  const source = await readFile(clientIdentityUrl, "utf8");
  const mobileRuntimeSource = await readFile(mobileRuntimeUrl, "utf8");
  globalThis.__clientIdentityTestMobileRuntime = await import(
    `data:text/javascript;base64,${Buffer.from(mobileRuntimeSource).toString("base64")}#mobile-runtime-${Date.now()}-${Math.random()}`
  );
  const capabilitySource = (
    await readFile(clientCapabilityProfileUrl, "utf8")
  ).replace(
    /import\s+\{[\s\S]*?\}\s+from\s+"@\/utils\/mobileRuntime";/,
    "const { detectIPadLikeNavigator, forcedMobilePlatform, mobileRuntimeForced } = globalThis.__clientIdentityTestMobileRuntime;"
  );
  globalThis.__clientIdentityTestCapability = await import(
    `data:text/javascript;base64,${Buffer.from(capabilitySource).toString("base64")}#capability-${Date.now()}-${Math.random()}`
  );
  globalThis.__clientIdentityTestDeviceKey = {
    deleted: 0,
    async deleteDeviceIdentityKeyRecord() {
      globalThis.__clientIdentityTestDeviceKey.deleted += 1;
      return true;
    },
  };
  const transformed = source
    .replace(
      'import { API_BASE } from "@/utils/constants";',
      `const API_BASE = ${JSON.stringify(apiBase)};`
    )
    .replace(
      /import\s+\{[\s\S]*?\}\s+from\s+"\.\/clientCapabilityProfile";/,
      "const { ATHENA_CAPABILITY_PROFILE_HEADER, ATHENA_CAPABILITY_PROFILE_QUERY, ATHENA_CAPABILITY_SOURCE_HEADER, encodeCapabilityProfile, getClientCapabilityProfile } = globalThis.__clientIdentityTestCapability;"
    )
    .replace(
      /import\s+\{[\s\S]*?\}\s+from\s+"@\/utils\/mobileRuntime";/,
      "const { detectIPadLikeNavigator, forcedMobilePlatform } = globalThis.__clientIdentityTestMobileRuntime;"
    )
    .replace(
      'import { deleteDeviceIdentityKeyRecord } from "./deviceIdentityKey";',
      "const { deleteDeviceIdentityKeyRecord } = globalThis.__clientIdentityTestDeviceKey;"
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

test("client identity reset drops local client id and optionally rotates device key", async () => {
  const originalWindow = globalThis.window;
  const storage = memoryStorage();
  globalThis.window = {
    localStorage: storage,
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
    const mod = await loadClientIdentity();
    const first = mod.getOrCreateClientId();
    await mod.resetClientIdentity();
    const second = mod.getOrCreateClientId();
    assert.notEqual(first, second);
    assert.equal(globalThis.__clientIdentityTestDeviceKey.deleted, 0);

    await mod.resetClientIdentity({ rotateDeviceKey: true });
    assert.equal(globalThis.__clientIdentityTestDeviceKey.deleted, 1);
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

test("force-mobile URL override syncs client identity metadata", async () => {
  const originalWindow = globalThis.window;
  const storage = memoryStorage();
  globalThis.window = {
    localStorage: memoryStorage(),
    sessionStorage: storage,
    location: {
      href: "https://athena.example.com/?athenaMobile=1&athenaPlatform=android",
      search: "?athenaMobile=1&athenaPlatform=android",
      origin: "https://athena.example.com",
    },
    innerWidth: 1280,
    innerHeight: 820,
    devicePixelRatio: 2,
    matchMedia: (query) => ({
      matches:
        query.includes("hover: hover") || query.includes("pointer: fine"),
    }),
    document: { createElement: () => ({}) },
    navigator: {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)",
      platform: "MacIntel",
      maxTouchPoints: 0,
    },
  };

  try {
    const mod = await loadClientIdentity();
    const identity = mod.getClientIdentity();
    assert.equal(identity.platform, "android");
    assert.equal(identity.capabilityProfile.surface, "pwa");
    assert.deepEqual(identity.capabilityProfile.input, {
      touch: true,
      hover: false,
      pointer: "coarse",
    });
  } finally {
    globalThis.window = originalWindow;
  }
});

test("iPad reports ipad platform while staying on browser surface", async () => {
  const originalWindow = globalThis.window;
  globalThis.window = {
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    location: {
      href: "https://athena.example.com/workspace/demo",
      search: "",
      origin: "https://athena.example.com",
    },
    innerWidth: 820,
    innerHeight: 1180,
    devicePixelRatio: 2,
    matchMedia: (query) => ({
      matches:
        query.includes("pointer: coarse") ||
        query.includes("any-pointer: coarse"),
    }),
    document: { createElement: () => ({}) },
    navigator: {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      platform: "MacIntel",
      maxTouchPoints: 5,
    },
  };

  try {
    const mod = await loadClientIdentity();
    const identity = mod.getClientIdentity();
    assert.equal(identity.platform, "ipad");
    assert.equal(identity.capabilityProfile.surface, "browser");
    assert.deepEqual(identity.capabilityProfile.device, {
      formFactor: "tablet",
      family: "ipad",
      os: "ipados",
    });
    assert.equal(identity.capabilities.fileSystem, false);
    assert.equal(identity.capabilities.localModel, false);
    assert.equal(identity.capabilities.screenshot, false);
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
