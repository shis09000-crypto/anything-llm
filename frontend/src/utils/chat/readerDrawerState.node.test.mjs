import test from "node:test";
import assert from "node:assert/strict";
import {
  clearReaderCurrentDocumentClearMarker,
  clearReaderCurrentDocumentStorage,
  clearReaderDrawerOpenIntent,
  isReaderCurrentDocumentFresh,
  readReaderCurrentDocumentClearedAt,
  readReaderDrawerState,
  READER_CURRENT_DOCUMENT_CLEAR_STORAGE_KEY,
  READER_CURRENT_DOCUMENT_STORAGE_KEY,
  READER_DRAWER_OPEN_STORAGE_KEY,
  READER_DRAWER_STATE_STORAGE_KEY,
  setReaderDrawerOpenIntent,
  setReaderDrawerSection,
} from "./readerDrawerState.js";

function installLocalStorageMock() {
  const storage = new Map();
  globalThis.localStorage = {
    get length() {
      return storage.size;
    },
    key: (index) => [...storage.keys()][index] ?? null,
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  return storage;
}

test("reader drawer state persists open and section while keeping legacy bool compatibility", () => {
  const storage = installLocalStorageMock();

  const opened = setReaderDrawerOpenIntent(true, { section: "bookshelf" });

  assert.equal(opened.open, true);
  assert.equal(opened.section, "bookshelf");
  assert.equal(storage.get(READER_DRAWER_OPEN_STORAGE_KEY), "true");
  assert.deepEqual(JSON.parse(storage.get(READER_DRAWER_STATE_STORAGE_KEY)), {
    open: true,
    section: "bookshelf",
    updatedAt: opened.updatedAt,
  });
  assert.equal(readReaderDrawerState().section, "bookshelf");
});

test("closing reader clears open intent but preserves last drawer section", () => {
  const storage = installLocalStorageMock();
  setReaderDrawerOpenIntent(true, { section: "workspace" });

  const closed = clearReaderDrawerOpenIntent();

  assert.equal(closed.open, false);
  assert.equal(closed.section, "workspace");
  assert.equal(storage.has(READER_DRAWER_OPEN_STORAGE_KEY), false);
  assert.equal(readReaderDrawerState().open, false);
  assert.equal(readReaderDrawerState().section, "workspace");
});

test("legacy boolean drawer key still restores an open history drawer", () => {
  const storage = installLocalStorageMock();
  storage.set(READER_DRAWER_OPEN_STORAGE_KEY, "true");

  assert.deepEqual(
    {
      open: readReaderDrawerState().open,
      section: readReaderDrawerState().section,
    },
    { open: true, section: "history" }
  );
});

test("reader drawer section updates without changing current open state", () => {
  installLocalStorageMock();
  setReaderDrawerOpenIntent(true, { section: "history" });

  const next = setReaderDrawerSection("workspace");

  assert.equal(next.open, true);
  assert.equal(next.section, "workspace");
});

test("clearReaderCurrentDocumentStorage removes global and legacy current documents and writes tombstone", () => {
  const storage = installLocalStorageMock();
  const legacyKey = "anythingllm_document_reader:v1:workspace-a:thread-a";
  const historyKey = "anythingllm_document_reader_history:v1:workspace-a";
  storage.set(
    READER_CURRENT_DOCUMENT_STORAGE_KEY,
    JSON.stringify({ title: "A" })
  );
  storage.set(legacyKey, JSON.stringify({ title: "B" }));
  storage.set(historyKey, JSON.stringify([{ title: "history" }]));

  const result = clearReaderCurrentDocumentStorage({ clearedAt: 1_000 });

  assert.equal(storage.has(READER_CURRENT_DOCUMENT_STORAGE_KEY), false);
  assert.equal(storage.has(legacyKey), false);
  assert.equal(storage.has(historyKey), true);
  assert.equal(storage.get(READER_CURRENT_DOCUMENT_CLEAR_STORAGE_KEY), "1000");
  assert.deepEqual(
    result.removed.sort(),
    [READER_CURRENT_DOCUMENT_STORAGE_KEY, legacyKey].sort()
  );
});

test("current document tombstone blocks older documents but allows newer opens", () => {
  installLocalStorageMock();
  clearReaderCurrentDocumentStorage({ clearedAt: 10_000 });

  assert.equal(readReaderCurrentDocumentClearedAt(), 10_000);
  assert.equal(
    isReaderCurrentDocumentFresh(
      { progress: { updatedAt: "1970-01-01T00:00:05.000Z" } },
      readReaderCurrentDocumentClearedAt()
    ),
    false
  );
  assert.equal(
    isReaderCurrentDocumentFresh(
      { progress: { updatedAt: "1970-01-01T00:00:20.000Z" } },
      readReaderCurrentDocumentClearedAt()
    ),
    true
  );

  clearReaderCurrentDocumentClearMarker();
  assert.equal(readReaderCurrentDocumentClearedAt(), 0);
});
