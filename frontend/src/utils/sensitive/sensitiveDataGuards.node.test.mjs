import test from "node:test";
import assert from "node:assert/strict";
import { redactSensitiveSnapshotEntry } from "./sensitiveDataGuards.js";

test("redacts sensitive websocket URL query params in diagnostic strings", () => {
  const entry = redactSensitiveSnapshotEntry({
    label:
      "websocket:GET wss://athena.example.com/api/realtime/broadcast?token=secret-token&resume=1",
    dedupeKey:
      "wss://athena.example.com/api/agent/demo?access_token=secret-access&x=1",
    scope: {
      path: "https://athena.example.com/api/file?signature=secret-signature",
    },
  });

  assert.match(entry.label, /token=\[redacted\]/);
  assert.match(entry.label, /resume=1/);
  assert.match(entry.dedupeKey, /access_token=\[redacted\]/);
  assert.match(entry.scope.path, /signature=\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(entry), /secret-token|secret-access|secret-signature/);
});
