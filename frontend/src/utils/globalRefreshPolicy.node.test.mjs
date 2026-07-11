import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import test from "node:test";

const policyUrl = new URL("./globalRefreshPolicy.js", import.meta.url);

async function loadPolicy() {
  const source = await readFile(policyUrl, "utf8");
  const body = source
    .replace(
      'import { recordCommunicationEvent } from "@/lib/communication/communicationMetrics";',
      "const recordCommunicationEvent = (event) => globalThis.__globalRefreshPolicyEvents.push(event);"
    )
    .replaceAll("export ", "");
  globalThis.__globalRefreshPolicyEvents = [];
  return import(
    `data:text/javascript;base64,${Buffer.from(
      `${body}
export { GLOBAL_REFRESH_ALLOWED_REASONS, globalRefreshReason, isGlobalRefreshAllowed, guardGlobalRefresh };`
    ).toString("base64")}#${Date.now()}-${Math.random()}`
  );
}

test("global refresh policy only allows crypto settings and account boundaries", async () => {
  const {
    GLOBAL_REFRESH_ALLOWED_REASONS,
    isGlobalRefreshAllowed,
    guardGlobalRefresh,
  } = await loadPolicy();

  assert.deepEqual(Array.from(GLOBAL_REFRESH_ALLOWED_REASONS).sort(), [
    "close-account",
    "close-crypto",
    "close-settings",
    "open-account",
    "open-crypto",
    "open-settings",
  ]);

  for (const reason of GLOBAL_REFRESH_ALLOWED_REASONS) {
    assert.equal(isGlobalRefreshAllowed({ reason }), true);
    assert.equal(guardGlobalRefresh({ detail: { reason } }).allowed, true);
  }

  for (const reason of [
    "workspace-created",
    "workspace-deleted",
    "thread-created",
    "thread-deleted",
    "reader-library-updated",
    "profile-updated",
    "sync.required",
    "",
  ]) {
    assert.equal(isGlobalRefreshAllowed({ reason }), false);
    assert.equal(guardGlobalRefresh({ detail: { reason } }).allowed, false);
  }

  const eventTypes = globalThis.__globalRefreshPolicyEvents.map(
    (event) => event.type
  );
  assert.equal(eventTypes.includes("global_refresh_allowed"), true);
  assert.equal(eventTypes.includes("global_refresh_blocked"), true);
});
