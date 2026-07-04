import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { optimisticActionCenter } from "../optimistic/optimisticActionCenter.js";
import { recoveryCenter } from "../recovery/recoveryCenter.js";
import { serverStateCache } from "../serverState/serverStateCache.js";

const moduleUrl = new URL("./sensitiveSessionCenter.js", import.meta.url);

function futureExpiry(ms = 60_000) {
  return new Date(Date.now() + ms).toISOString();
}

function installWindowStub() {
  const listeners = new Map();
  const documentListeners = new Map();
  const makeTarget = (bucket) => ({
    addEventListener(type, listener) {
      const list = bucket.get(type) || [];
      list.push(listener);
      bucket.set(type, list);
    },
    dispatchEvent(event) {
      const type = typeof event === "string" ? event : event?.type;
      for (const listener of bucket.get(type) || []) listener(event);
      return true;
    },
  });
  const documentTarget = makeTarget(documentListeners);
  documentTarget.visibilityState = "visible";
  const windowTarget = makeTarget(listeners);
  windowTarget.document = documentTarget;
  windowTarget.localStorage = {
    getItem() {
      return "true";
    },
  };
  globalThis.window = windowTarget;
  globalThis.document = documentTarget;
  return {
    window: windowTarget,
    document: documentTarget,
    cleanup() {
      delete globalThis.window;
      delete globalThis.document;
    },
  };
}

async function loadSensitiveSessionCenter({ postJson } = {}) {
  const source = await readFile(moduleUrl, "utf8");
  globalThis.__sensitiveSessionTestApiClient = {
    calls: [],
    async postJson(path, body, options) {
      const call = { path, body, options };
      globalThis.__sensitiveSessionTestApiClient.calls.push(call);
      if (typeof postJson === "function") return postJson(call);
      return { data: { success: true } };
    },
  };
  const transformed = source
    .replace(
      'import { AUTH_SESSION_CLEARED_EVENT } from "@/utils/authTokenStorage";',
      'const AUTH_SESSION_CLEARED_EVENT = "athena-auth-session-cleared";'
    )
    .replace(
      /async function postJson\(path, body, options\) \{\s*const client = await import\("@\/lib\/communication\/apiClient"\);\s*return client\.postJson\(path, body, options\);\s*\}/,
      "async function postJson(path, body, options) { return globalThis.__sensitiveSessionTestApiClient.postJson(path, body, options); }"
    )
    .replaceAll("import.meta.env?.DEV", "true");

  return import(
    `data:text/javascript;base64,${Buffer.from(transformed).toString(
      "base64"
    )}#${Date.now()}-${Math.random()}`
  );
}

test.beforeEach(() => {
  serverStateCache.clear();
  recoveryCenter.resetForTests();
});

test.afterEach(() => {
  delete globalThis.__sensitiveSessionTestApiClient;
});

test("normal path: heartbeat uses scheduler-only sensitive-session metadata and redacted snapshots", async () => {
  const windowStub = installWindowStub();
  try {
    const { sensitiveSessionCenter, SENSITIVE_SESSION_HEADER } =
      await loadSensitiveSessionCenter();
    sensitiveSessionCenter.store(
      {
        token: "ssn_reader_secret",
        sessionId: "ssn_reader_secret",
        resourceType: "reader_document",
        resourceId: "doc-1",
        ownerScope: "workspace:a:reader",
      },
      {
        resourceType: "reader_document",
        resourceId: "doc-1",
        ownerScope: "workspace:a:reader",
      }
    );

    const result = await sensitiveSessionCenter.heartbeat({
      resourceType: "reader_document",
      resourceId: "doc-1",
    });
    const [call] = globalThis.__sensitiveSessionTestApiClient.calls;

    assert.deepEqual(result, { success: true });
    assert.equal(call.path, "/sensitive-sessions/heartbeat");
    assert.equal(call.body.sensitiveSession, "ssn_reader_secret");
    assert.equal(call.options.signing, "required");
    assert.equal(call.options.communicationScene, "sensitive-session");
    assert.equal(
      call.options.headers[SENSITIVE_SESSION_HEADER],
      "ssn_reader_secret"
    );
    assert.equal(call.options.task.kind, "sensitive-session");
    assert.equal(call.options.task.priority, "P1");
    assert.equal(call.options.task.protected, true);
    assert.equal(call.options.task.abortable, false);
    assert.equal(call.options.task.resource, "network");
    assert.equal(call.options.task.scope.domain, "sensitive-session");
    assert.equal(call.options.task.scope.hasResourceId, true);

    const snapshot = sensitiveSessionCenter.snapshot();
    assert.equal(snapshot.transport.schedulerOnly, true);
    assert.equal(snapshot.transport.communicationScene, "sensitive-session");
    assert.equal(
      snapshot.sessions[0].sessionId,
      "[redacted-sensitive-session]"
    );
    assert.equal(JSON.stringify(snapshot).includes("ssn_reader_secret"), false);
  } finally {
    windowStub.cleanup();
  }
});

test("missing secret path: headers are empty and heartbeat skips without creating a fake session", async () => {
  const windowStub = installWindowStub();
  try {
    const { sensitiveSessionCenter } = await loadSensitiveSessionCenter();

    assert.deepEqual(
      sensitiveSessionCenter.headers({
        resourceType: "reader_document",
        resourceId: "missing-doc",
      }),
      {}
    );
    assert.deepEqual(
      await sensitiveSessionCenter.heartbeat({
        resourceType: "reader_document",
        resourceId: "missing-doc",
      }),
      { success: true, skipped: true }
    );
    assert.equal(globalThis.__sensitiveSessionTestApiClient.calls.length, 0);
    assert.equal(sensitiveSessionCenter.snapshot().size, 0);
  } finally {
    windowStub.cleanup();
  }
});

test("reader aliases resolve to the same sensitive session without duplicate snapshot entries", async () => {
  const windowStub = installWindowStub();
  try {
    const { sensitiveSessionCenter, SENSITIVE_SESSION_HEADER } =
      await loadSensitiveSessionCenter();
    sensitiveSessionCenter.store(
      {
        token: "ssn_reader_alias_secret",
        sessionId: "ssn_reader_alias_secret",
        resourceType: "reader_document",
        resourceId: "workspace-a:doc-alias",
      },
      {
        resourceType: "reader_document",
        resourceId: "workspace-a:doc-alias",
        aliasResourceIds: ["doc-alias"],
      }
    );

    assert.deepEqual(
      sensitiveSessionCenter.headers({
        resourceType: "reader_document",
        resourceId: "doc-alias",
      }),
      { [SENSITIVE_SESSION_HEADER]: "ssn_reader_alias_secret" }
    );
    assert.deepEqual(
      sensitiveSessionCenter.headers({
        resourceType: "reader_document",
        resourceId: "workspace-a:doc-alias",
      }),
      { [SENSITIVE_SESSION_HEADER]: "ssn_reader_alias_secret" }
    );
    assert.equal(sensitiveSessionCenter.snapshot().size, 1);

    await sensitiveSessionCenter.revoke(
      {
        resourceType: "reader_document",
        resourceId: "doc-alias",
      },
      "alias-revoke"
    );
    assert.equal(sensitiveSessionCenter.snapshot().size, 0);
    assert.deepEqual(
      sensitiveSessionCenter.headers({
        resourceType: "reader_document",
        resourceId: "workspace-a:doc-alias",
      }),
      {}
    );
  } finally {
    windowStub.cleanup();
  }
});

test("abnormal path: heartbeat failure clears the local session and heartbeat timer", async () => {
  const windowStub = installWindowStub();
  try {
    const { sensitiveSessionCenter } = await loadSensitiveSessionCenter({
      postJson: async () => {
        throw new Error("network down");
      },
    });
    sensitiveSessionCenter.store(
      {
        token: "ssn_failure_secret",
        resourceType: "reader_document",
        resourceId: "doc-failure",
        expiresAt: futureExpiry(),
      },
      {
        resourceType: "reader_document",
        resourceId: "doc-failure",
      }
    );

    const result = await sensitiveSessionCenter.heartbeat({
      resourceType: "reader_document",
      resourceId: "doc-failure",
    });

    assert.deepEqual(result, { success: false });
    assert.equal(sensitiveSessionCenter.snapshot().size, 0);
    assert.equal(
      sensitiveSessionCenter.snapshot().transport.activeHeartbeatTimers,
      0
    );
  } finally {
    windowStub.cleanup();
  }
});

test("pressure path: page blur revokes all sessions with one scheduled scope revoke, not N revokes", async () => {
  const windowStub = installWindowStub();
  try {
    const { sensitiveSessionCenter } = await loadSensitiveSessionCenter();
    for (let index = 0; index < 20; index += 1) {
      sensitiveSessionCenter.store(
        {
          token: `ssn_pressure_${index}`,
          resourceType: "reader_document",
          resourceId: `doc-${index}`,
        },
        {
          resourceType: "reader_document",
          resourceId: `doc-${index}`,
        }
      );
    }

    windowStub.window.dispatchEvent({ type: "blur" });
    const calls = globalThis.__sensitiveSessionTestApiClient.calls;

    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/sensitive-sessions/revoke-scope");
    assert.equal(calls[0].body.reason, "window-blur");
    assert.equal(calls[0].options.task.kind, "sensitive-session");
    assert.equal(calls[0].options.task.priority, "P0");
    assert.equal(calls[0].options.task.protected, true);
    assert.equal(calls[0].options.task.dedupeKey.includes("revoke-all"), true);
    assert.equal(sensitiveSessionCenter.snapshot().size, 0);
  } finally {
    windowStub.cleanup();
  }
});

test("mixed center path: cache, optimistic, and recovery callbacks can only route through sensitive-session scheduled metadata", async () => {
  const windowStub = installWindowStub();
  try {
    const { sensitiveSessionCenter } = await loadSensitiveSessionCenter();
    sensitiveSessionCenter.store(
      {
        token: "ssn_mixed_secret",
        resourceType: "vault",
        resourceId: "vault",
      },
      { resourceType: "vault", resourceId: "vault" }
    );

    await serverStateCache.refresh(
      "workspace.safe-state",
      async () => {
        await sensitiveSessionCenter.heartbeat({
          resourceType: "vault",
          resourceId: "vault",
        });
        return { ok: true };
      },
      {
        priority: "P1",
        scope: { domain: "workspace" },
      }
    );

    const action = optimisticActionCenter.run({
      type: "sensitive.mixed.revoke",
      scope: { surface: "mixed-center" },
      serverCall: () =>
        sensitiveSessionCenter.revokeScope(
          { resourceType: "vault", resourceId: "vault" },
          "optimistic-mixed-call"
        ),
    });
    await action.promise;

    recoveryCenter.handle(new Error("Failed to fetch"), {
      source: "sensitive-test",
      autoRetry: true,
      retry: () =>
        sensitiveSessionCenter.revokeScope(
          { resourceType: "vault" },
          "recovery-retry-mixed-call"
        ),
    });

    const calls = globalThis.__sensitiveSessionTestApiClient.calls;
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map((call) => call.path),
      [
        "/sensitive-sessions/heartbeat",
        "/sensitive-sessions/revoke-scope",
        "/sensitive-sessions/revoke-scope",
      ]
    );
    for (const call of calls) {
      assert.equal(call.options.communicationScene, "sensitive-session");
      assert.equal(call.options.signing, "required");
      assert.equal(call.options.task.kind, "sensitive-session");
      assert.equal(call.options.task.protected, true);
      assert.match(call.options.task.dedupeKey, /^sensitive-session:/);
    }
  } finally {
    windowStub.cleanup();
  }
});

test("mixed center path: ServerStateCache rejects sensitive session keys and metadata", async () => {
  assert.throws(
    () => serverStateCache.set("sensitive-session:reader:doc-1", { ok: true }),
    (error) => error.code === "SENSITIVE_SERVER_STATE_FORBIDDEN"
  );
  assert.throws(
    () =>
      serverStateCache.set(
        "reader.safe-key",
        { token: "ssn_should_not_cache" },
        { meta: { sensitive: true } }
      ),
    (error) => error.code === "SENSITIVE_SERVER_STATE_FORBIDDEN"
  );
});
