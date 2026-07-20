import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeUrl = new URL("./syncV2Runtime.js", import.meta.url);

async function loadRuntime({
  pages = [],
  descriptors = {},
  payloadKeys = [],
} = {}) {
  const source = await readFile(runtimeUrl, "utf8");
  const calls = { batchGet: [], acknowledge: [], applied: [], cursor: 0 };
  globalThis.window = {
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    addEventListener() {},
  };
  globalThis.document = { visibilityState: "visible" };
  globalThis.__syncV2Client = {
    async events() {
      return pages.shift();
    },
    async batchGet(requests) {
      calls.batchGet.push(requests);
      return {
        nodes: requests.map((request) => ({
          descriptor: {
            nodeKey: request.nodeKey,
            stateVersion: 100,
            hash: `hash:${request.nodeKey}`,
          },
          payload: null,
        })),
      };
    },
    async acknowledge(cursor) {
      calls.acknowledge.push(cursor);
    },
  };
  globalThis.__syncV2StateStore = {
    ownerScope() {
      return "test-owner";
    },
    descriptor(nodeKey) {
      return descriptors[nodeKey] || null;
    },
    hasPayload(nodeKey) {
      return payloadKeys.includes(nodeKey);
    },
    async applyNodesBatch(nodes) {
      calls.applied.push(nodes);
      return nodes.length;
    },
    cursor() {
      return calls.cursor;
    },
    setCursor(cursor) {
      calls.cursor = Math.max(calls.cursor, Number(cursor) || 0);
      return calls.cursor;
    },
    descriptors() {
      return descriptors;
    },
    diagnostics() {
      return { sync_descriptor_commits: calls.applied.length };
    },
  };
  globalThis.__syncMutationQueue = {
    snapshot() {
      return {};
    },
    async flush() {},
  };
  globalThis.__syncV2NodeArchive = {
    async storeMany() {
      return true;
    },
    async prune() {
      return true;
    },
    diagnostics() {
      return {};
    },
  };

  const body = source
    .replace(
      'import { syncV2Client } from "@/lib/communication/syncV2Client";',
      "const syncV2Client = globalThis.__syncV2Client;"
    )
    .replace(
      'import { syncV2StateStore } from "./syncV2StateStore";',
      "const syncV2StateStore = globalThis.__syncV2StateStore;"
    )
    .replace(
      'import { syncMutationQueue } from "./syncMutationQueue";',
      "const syncMutationQueue = globalThis.__syncMutationQueue;"
    )
    .replace(
      'import { syncV2NodeArchive } from "./syncV2NodeArchive";',
      "const syncV2NodeArchive = globalThis.__syncV2NodeArchive;"
    );
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(
      `${body}\nexport { replayEvents as __replayEvents };`
    ).toString("base64")}#${Date.now()}-${Math.random()}`
  );
  return { module, calls };
}

function events(count, distinctNodes) {
  return Array.from({ length: count }, (_, index) => ({
    seq: index + 1,
    nodeKey: `nodes/${index % distinctNodes}`,
    stateVersion: index + 1,
  }));
}

test("event replay deduplicates 200 events for 20 nodes into one fetch and one ACK", async () => {
  const { module, calls } = await loadRuntime({
    pages: [
      {
        events: events(200, 20),
        nextSeq: 200,
        hasMore: false,
        requiresFullSync: false,
      },
    ],
  });

  await module.__replayEvents(0);

  assert.equal(calls.batchGet.length, 1);
  assert.equal(calls.batchGet[0].length, 20);
  assert.deepEqual(calls.acknowledge, [200]);
  assert.equal(calls.cursor, 200);
});

test("event replay chunks 200 distinct nodes into two fetches and commits once", async () => {
  const { module, calls } = await loadRuntime({
    pages: [
      {
        events: events(200, 200),
        nextSeq: 200,
        hasMore: false,
        requiresFullSync: false,
      },
    ],
  });

  await module.__replayEvents(0);

  assert.deepEqual(
    calls.batchGet.map((requests) => requests.length),
    [100, 100]
  );
  assert.equal(calls.applied.length, 1);
  assert.deepEqual(calls.acknowledge, [200]);
});

test("live events share one 25ms fetch and cursor ACK", async () => {
  const { module, calls } = await loadRuntime();

  await Promise.all(
    events(20, 5).map((event) => module.syncV2Runtime.processEvent(event))
  );

  assert.equal(calls.batchGet.length, 1);
  assert.equal(calls.batchGet[0].length, 5);
  assert.equal(calls.applied.length, 1);
  assert.deepEqual(calls.acknowledge, [20]);
});

test("locally projected mutation satisfies its own echo without batchGet", async () => {
  const nodeKey = "users/7/preferences/chat.draft/thread%3Aws-a%3Athread-a";
  const { module, calls } = await loadRuntime({
    descriptors: {
      [nodeKey]: { nodeKey, stateVersion: 10, hash: "hash:draft" },
    },
    payloadKeys: [nodeKey],
  });

  await module.syncV2Runtime.processEvent({
    seq: 44,
    nodeKey,
    stateVersion: 10,
    originClientId: "device-a",
  });

  assert.equal(calls.batchGet.length, 0);
  assert.deepEqual(calls.acknowledge, [44]);
  assert.equal(
    module.syncV2Runtime.snapshot().metrics.sync_locally_satisfied_events,
    1
  );
});
