import test from "node:test";
import assert from "node:assert/strict";
import {
  nextReaderPostprocessDelay,
  readerPostprocessIsForeground,
  readerPostprocessLockKey,
  readerPostprocessPollTimeoutMs,
  readerPostprocessScheduleOptions,
} from "./postprocessScheduling.js";

test("automatic reader postprocess stays in idle background priority", () => {
  const options = readerPostprocessScheduleOptions({
    intent: "maintenance",
    workspaceSlug: "workspace-a",
    readerDocumentId: "doc-1",
  });

  assert.equal(options.foreground, false);
  assert.equal(options.priority, "P4");
  assert.equal(options.policy, "maintenance");
  assert.equal(options.resource, "idle");
  assert.equal(options.emergency, false);
  assert.equal(options.dedupeKey, "reader:postprocess:workspace-a:doc-1");
});

test("manual reader postprocess is foreground emergency active intent", () => {
  const options = readerPostprocessScheduleOptions({
    intent: "manual",
    workspaceSlug: "workspace-a",
    readerDocumentId: "doc-1",
  });

  assert.equal(readerPostprocessIsForeground("manual"), true);
  assert.equal(options.foreground, true);
  assert.equal(options.priority, "P0");
  assert.equal(options.policy, "foreground");
  assert.equal(options.resource, "network");
  assert.equal(options.emergency, true);
  assert.equal(options.intentRank, 0);
});

test("postprocess lock key ignores intent so one document has one poller", () => {
  const lockKey = readerPostprocessLockKey({
    workspaceSlug: "workspace-a",
    readerDocumentId: "doc-1",
  });
  const autoOptions = readerPostprocessScheduleOptions({
    intent: "maintenance",
    workspaceSlug: "workspace-a",
    readerDocumentId: "doc-1",
  });
  const manualOptions = readerPostprocessScheduleOptions({
    intent: "manual",
    workspaceSlug: "workspace-a",
    readerDocumentId: "doc-1",
  });

  assert.equal(lockKey, "workspace-a:doc-1");
  assert.equal(autoOptions.dedupeKey, manualOptions.dedupeKey);
});

test("automatic polling times out earlier and backs off more when hidden", () => {
  assert.equal(readerPostprocessPollTimeoutMs({ foreground: false }), 45_000);
  assert.equal(
    readerPostprocessPollTimeoutMs({
      foreground: false,
      serverTimeoutMs: 12_000,
    }),
    12_000
  );
  assert.equal(readerPostprocessPollTimeoutMs({ foreground: true }), 120_000);
  assert.equal(
    nextReaderPostprocessDelay(1_000, {
      foreground: false,
      hidden: false,
      random: () => 0.5,
    }),
    1_500
  );
  assert.equal(
    nextReaderPostprocessDelay(1_000, {
      foreground: false,
      hidden: true,
      random: () => 0.5,
    }),
    1_800
  );
});
