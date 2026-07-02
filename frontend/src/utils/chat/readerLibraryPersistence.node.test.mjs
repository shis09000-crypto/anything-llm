import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeReaderLibraryBookshelfItems,
  removableBookshelfKeysAfterReaderDelete,
} from "./readerLibraryPersistence.js";

test("mergeReaderLibraryBookshelfItems keeps server-backed local books when remote bookshelf is empty", () => {
  const local = [
    {
      title: "红色资本.pdf",
      key: "red-capital:main",
      readerDocumentId: "doc-1",
      readerDocumentWorkspaceSlug: "workspace-a",
    },
  ];

  const merged = mergeReaderLibraryBookshelfItems(local, []);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].readerDocumentId, "doc-1");
  assert.equal(merged[0].readerDocumentWorkspaceSlug, "workspace-a");
});

test("mergeReaderLibraryBookshelfItems merges remote UI metadata without dropping server ids", () => {
  const merged = mergeReaderLibraryBookshelfItems(
    [
      {
        title: "金钱心理学.pdf",
        key: "money-psychology:main",
        readerDocumentId: "doc-2",
        category: { primaryCategoryId: "finance" },
      },
    ],
    [
      {
        title: "金钱心理学.pdf",
        key: "money-psychology:main",
        progress: { percent: 42 },
      },
    ]
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].readerDocumentId, "doc-2");
  assert.deepEqual(merged[0].category, { primaryCategoryId: "finance" });
  assert.deepEqual(merged[0].progress, { percent: 42 });
});

test("removableBookshelfKeysAfterReaderDelete only removes server-backed books after confirmed server deletion", () => {
  const items = [
    { key: "local-only:main", title: "Local only" },
    { key: "server-ok:main", title: "Server ok", readerDocumentId: "doc-ok" },
    {
      key: "server-failed:main",
      title: "Server failed",
      readerDocumentId: "doc-failed",
    },
  ];

  const keys = removableBookshelfKeysAfterReaderDelete(items, ["doc-ok"]);

  assert.deepEqual(keys.sort(), ["local-only:main", "server-ok:main"].sort());
});
