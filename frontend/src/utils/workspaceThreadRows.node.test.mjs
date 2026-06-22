import test from "node:test";
import assert from "node:assert/strict";
import {
  COLLAPSED_THREAD_LIMIT,
  visibleThreadRows,
} from "./workspaceThreadRows.js";

function row(slug, extra = {}) {
  return { thread: { slug, ...extra }, activity: null };
}

test("collapsed thread rows keep active thread outside first five", () => {
  const rows = [
    row("overview", { thread_type: "overview" }),
    ...Array.from({ length: 8 }, (_, index) => row(`thread-${index + 1}`)),
  ];

  const result = visibleThreadRows({
    sortedThreadRows: rows,
    activeThreadSlug: "thread-8",
    expanded: false,
  });

  assert.equal(COLLAPSED_THREAD_LIMIT, 5);
  assert.deepEqual(
    result.threadRows.map(({ thread }) => thread.slug),
    [
      "overview",
      "thread-1",
      "thread-2",
      "thread-3",
      "thread-4",
      "thread-5",
      "thread-8",
    ]
  );
  assert.equal(result.hiddenThreadCount, 3);
});

test("collapsed thread rows do not duplicate active thread already visible", () => {
  const rows = Array.from({ length: 8 }, (_, index) =>
    row(`thread-${index + 1}`)
  );

  const result = visibleThreadRows({
    sortedThreadRows: rows,
    activeThreadSlug: "thread-2",
    expanded: false,
  });

  assert.deepEqual(
    result.threadRows.map(({ thread }) => thread.slug),
    ["thread-1", "thread-2", "thread-3", "thread-4", "thread-5"]
  );
});

test("expanded thread rows return full sorted list", () => {
  const rows = Array.from({ length: 7 }, (_, index) =>
    row(`thread-${index + 1}`)
  );

  const result = visibleThreadRows({
    sortedThreadRows: rows,
    activeThreadSlug: "thread-7",
    expanded: true,
  });

  assert.equal(result.threadRows.length, 7);
  assert.equal(result.hiddenThreadCount, 0);
});
