import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import * as apiError from "./apiError.js";

const signingClientUrl = new URL("./requestSigningClient.js", import.meta.url);
const routeCasesUrl = new URL(
  "../../../../server/scripts/request-signing-route-cases.json",
  import.meta.url
);

function memoryStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    has: (key) => store.has(key),
  };
}

async function loadSigningClient({ dev = false, prod = false } = {}) {
  const source = await readFile(signingClientUrl, "utf8");
  globalThis.__signingTestBaseHeaders = () => ({
    Authorization: "Bearer test-token",
  });
  globalThis.__signingTestApiError = apiError;
  globalThis.__signingTestIdentity = {
    ATHENA_CLIENT_ID_HEADER: "X-Athena-Client-Id",
    ATHENA_REQUEST_ID_HEADER: "X-Athena-Request-Id",
    createCommunicationRequestId: () => "secret-req",
    getClientIdentity: () => ({
      clientId: "client_sign",
      platform: "web",
      appVersion: "test",
    }),
    withClientIdentityHeaders: (headers = {}, { requestId } = {}) => ({
      ...headers,
      "X-Athena-Client-Id": "client_sign",
      "X-Athena-Platform": "web",
      "X-Athena-App-Version": "test",
      "X-Athena-Request-Id": requestId,
    }),
  };
  globalThis.__signingTestSecurity = {
    assertSecureHttpUrl: (url) => url,
  };
  globalThis.__signingTestDeviceKey = {
    signWithDeviceIdentityKey: async () => null,
  };
  globalThis.__signingTestTaskRequestMetadata = {
    runScheduledTaskRequest: (operation, request = {}) =>
      operation({ signal: request.signal, handle: null }),
  };

  const transformed = source
    .replace(
      'import { API_BASE } from "@/utils/constants";',
      'const API_BASE = "/api";'
    )
    .replace(
      'import { baseHeaders } from "@/utils/request";',
      "const baseHeaders = globalThis.__signingTestBaseHeaders;"
    )
    .replace(
      'import { API_ERROR_CODES, createApiError, normalizeApiError } from "./apiError";',
      "const { API_ERROR_CODES, createApiError, normalizeApiError } = globalThis.__signingTestApiError;"
    )
    .replace(
      /import\s+\{[\s\S]*?\}\s+from\s+"\.\/clientIdentity";/,
      `const {
        ATHENA_CLIENT_ID_HEADER,
        ATHENA_REQUEST_ID_HEADER,
        createCommunicationRequestId,
        getClientIdentity,
        withClientIdentityHeaders,
      } = globalThis.__signingTestIdentity;`
    )
    .replace(
      'import { signWithDeviceIdentityKey } from "./deviceIdentityKey";',
      "const { signWithDeviceIdentityKey } = globalThis.__signingTestDeviceKey;"
    )
    .replace(
      'import { assertSecureHttpUrl } from "./transportSecurity";',
      "const { assertSecureHttpUrl } = globalThis.__signingTestSecurity;"
    )
    .replace(
      'import { AUTH_SESSION_CLEARED_EVENT } from "@/utils/authTokenStorage";',
      'const AUTH_SESSION_CLEARED_EVENT = "athena-auth-session-cleared";'
    )
    .replace(
      'import { runScheduledTaskRequest } from "@/utils/tasks/taskRequestMetadata";',
      "const { runScheduledTaskRequest } = globalThis.__signingTestTaskRequestMetadata;"
    )
    .replaceAll("import.meta.env.PROD", JSON.stringify(prod))
    .replaceAll("import.meta.env.DEV", JSON.stringify(dev));

  return import(
    `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}#${Date.now()}-${Math.random()}`
  );
}

test("signedRequestHeaders signs body and uses sessionStorage secret only", async () => {
  const originalWindow = globalThis.window;
  const sessionStorage = memoryStorage();
  const localStorage = memoryStorage();
  sessionStorage.setItem(
    "athena_signing_secret_v1:client_sign",
    "secret_from_session"
  );
  globalThis.window = {
    sessionStorage,
    localStorage,
    location: {
      href: "http://localhost:3000",
      origin: "http://localhost:3000",
    },
  };

  try {
    const mod = await loadSigningClient({ dev: true });
    const headers = await mod.signedRequestHeaders({
      method: "POST",
      url: "/api/workspace/demo/tool-approval?x=1",
      requestId: "req_sign",
      bodyString: JSON.stringify({ approved: true }),
    });
    const changed = await mod.signedRequestHeaders({
      method: "POST",
      url: "/api/workspace/demo/tool-approval?x=1",
      requestId: "req_sign_2",
      bodyString: JSON.stringify({ approved: false }),
    });

    assert.equal(headers["X-Athena-Client-Id"], "client_sign");
    assert.equal(headers["X-Athena-Request-Id"], "req_sign");
    assert.equal(headers["X-Athena-Signature-Version"], "v1");
    assert.ok(headers["X-Athena-Nonce"]);
    assert.ok(headers["X-Athena-Signature"]);
    assert.notEqual(
      headers["X-Athena-Body-SHA256"],
      changed["X-Athena-Body-SHA256"]
    );
    assert.equal(
      localStorage.has("athena_signing_secret_v1:client_sign"),
      false
    );
  } finally {
    globalThis.window = originalWindow;
  }
});

test("getSigningSecret fetches once and caches in sessionStorage, not localStorage", async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const sessionStorage = memoryStorage();
  const localStorage = memoryStorage();
  const fetches = [];
  globalThis.window = {
    sessionStorage,
    localStorage,
    location: {
      href: "http://localhost:3000",
      origin: "http://localhost:3000",
    },
  };
  globalThis.fetch = async (url, init) => {
    fetches.push({ url, init });
    return new Response(
      JSON.stringify({ success: true, signingSecret: "server_secret" }),
      { status: 200 }
    );
  };

  try {
    const mod = await loadSigningClient({ dev: true });
    assert.equal(await mod.getSigningSecret(), "server_secret");
    assert.equal(await mod.getSigningSecret(), "server_secret");
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0].url, "/api/client-identity/signing-secret");
    assert.equal(fetches[0].init.headers.Authorization, "Bearer test-token");
    assert.equal(
      sessionStorage.getItem("athena_signing_secret_v1:client_sign"),
      "server_secret"
    );
    assert.equal(
      localStorage.has("athena_signing_secret_v1:client_sign"),
      false
    );
  } finally {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});

test("CLIENT_REVOKED signing secret responses produce ApiError and clear cache", async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const sessionStorage = memoryStorage();
  globalThis.window = {
    sessionStorage,
    localStorage: memoryStorage(),
    location: {
      href: "http://localhost:3000",
      origin: "http://localhost:3000",
    },
  };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ success: false, error: "CLIENT_REVOKED" }), {
      status: 403,
    });

  try {
    const mod = await loadSigningClient({ dev: true });
    await assert.rejects(
      mod.getSigningSecret(),
      (error) => error.code === "CLIENT_REVOKED" && error.status === 403
    );
    sessionStorage.setItem("athena_signing_secret_v1:client_sign", "stale");
    mod.clearSigningSecretCache("client_sign");
    assert.equal(
      sessionStorage.getItem("athena_signing_secret_v1:client_sign"),
      null
    );
  } finally {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});

test("signing cache can be updated and recoverable signing errors are detected", async () => {
  const originalWindow = globalThis.window;
  const sessionStorage = memoryStorage();
  globalThis.window = {
    sessionStorage,
    localStorage: memoryStorage(),
    location: {
      href: "http://localhost:3000",
      origin: "http://localhost:3000",
    },
  };

  try {
    const mod = await loadSigningClient({ dev: true });
    mod.setSigningSecretCache("client_sign", "rotated_secret");
    assert.equal(
      sessionStorage.getItem("athena_signing_secret_v1:client_sign"),
      "rotated_secret"
    );
    assert.equal(mod.isRecoverableSigningError("INVALID_SIGNATURE"), true);
    assert.equal(
      mod.isRecoverableSigningError({
        raw: { error: "SIGNING_SECRET_ROTATED" },
      }),
      true
    );
    assert.equal(mod.isRecoverableSigningError("CLIENT_REVOKED"), false);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("websocket signing canonical path ignores volatile query parameters", async () => {
  const originalWindow = globalThis.window;
  globalThis.window = {
    sessionStorage: memoryStorage(),
    localStorage: memoryStorage(),
    location: {
      href: "https://athenallm.online/workspace/demo",
      origin: "https://athenallm.online",
    },
  };

  try {
    const mod = await loadSigningClient({ dev: true });
    assert.equal(
      mod.canonicalWebSocketPathFromUrl(
        "wss://athenallm.online/api/agent-invocation/abc?token=jwt&resume=1&lastEventSeq=9&athenaClientId=client_1"
      ),
      "/api/agent-invocation/abc"
    );
  } finally {
    globalThis.window = originalWindow;
  }
});

test("auto signing is warn-only in development and required in production", async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  globalThis.window = {
    sessionStorage: memoryStorage(),
    localStorage: memoryStorage(),
    location: {
      href: "http://localhost:3000",
      origin: "http://localhost:3000",
    },
  };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ success: false }), { status: 500 });

  try {
    const devMod = await loadSigningClient({ dev: true, prod: false });
    const devResult = await devMod.maybeSignedRequestHeaders({
      method: "POST",
      path: "/workspace/demo/tool-approval",
      url: "/api/workspace/demo/tool-approval",
      requestId: "req_dev",
      bodyString: "{}",
    });
    assert.equal(devResult.signed, false);

    const prodMod = await loadSigningClient({ dev: false, prod: true });
    await assert.rejects(
      prodMod.maybeSignedRequestHeaders({
        method: "POST",
        path: "/workspace/demo/tool-approval",
        url: "/api/workspace/demo/tool-approval",
        requestId: "req_prod",
        bodyString: "{}",
      }),
      (error) => error.ok === false
    );
  } finally {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});

test("high-risk matcher only selects configured mutating paths", async () => {
  const mod = await loadSigningClient();
  const routeCases = JSON.parse(await readFile(routeCasesUrl, "utf8"));

  for (const [method, path] of routeCases.signed) {
    assert.equal(
      mod.shouldSignHighRiskRequest({ method, path }),
      true,
      `${method} ${path} should be signed`
    );
  }

  for (const [method, path] of routeCases.unsigned) {
    assert.equal(
      mod.shouldSignHighRiskRequest({ method, path }),
      false,
      `${method} ${path} should not be auto-signed`
    );
  }
});
