import test from "node:test";
import assert from "node:assert/strict";
import {
  applyWorkspaceLayoutStorageEvent,
  deriveLayoutMode,
  readInitialLayoutIntent,
  readSidebarCollapsed,
  READER_CURRENT_DOCUMENT_STORAGE_KEY,
  READER_SPLIT_PERCENT_STORAGE_KEY,
  SIDEBAR_COLLAPSED_BY_WORKSPACE_STORAGE_KEY,
  workspaceLayoutReducer,
} from "./workspaceLayoutState.js";
import {
  READER_DRAWER_STATE_STORAGE_KEY,
  READER_CURRENT_DOCUMENT_CLEAR_STORAGE_KEY,
} from "../chat/readerDrawerState.js";

function installLocalStorageMock(pathname = "/workspace/ws-a/t/thread-a") {
  const storage = new Map();
  const localStorage = {
    get length() {
      return storage.size;
    },
    key: (index) => [...storage.keys()][index] ?? null,
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  globalThis.localStorage = localStorage;
  globalThis.window = { localStorage, location: { pathname } };
  return storage;
}

test("refreshing with reader drawer intent starts in readerDrawer mode", () => {
  const storage = installLocalStorageMock();
  storage.set(
    READER_DRAWER_STATE_STORAGE_KEY,
    JSON.stringify({ open: true, section: "history", updatedAt: 1 })
  );

  const state = readInitialLayoutIntent();

  assert.equal(state.mode, "readerDrawer");
  assert.equal(state.readerOpen, true);
  assert.equal(state.readerType, "drawer");
});

test("refreshing with current reader document starts in readerDocument mode", () => {
  const storage = installLocalStorageMock();
  storage.set(
    READER_CURRENT_DOCUMENT_STORAGE_KEY,
    JSON.stringify({
      title: "Doc",
      readerDocumentId: "doc-1",
      progress: { updatedAt: "2026-01-01T00:00:00.000Z" },
    })
  );

  const state = readInitialLayoutIntent();

  assert.equal(state.mode, "readerDocument");
  assert.equal(state.readerOpen, true);
  assert.equal(state.readerType, "document");
});

test("reader document tombstone falls back to drawer intent", () => {
  const storage = installLocalStorageMock();
  storage.set(
    READER_CURRENT_DOCUMENT_STORAGE_KEY,
    JSON.stringify({
      title: "Doc",
      readerDocumentId: "doc-1",
      progress: { updatedAt: "1970-01-01T00:00:01.000Z" },
    })
  );
  storage.set(READER_CURRENT_DOCUMENT_CLEAR_STORAGE_KEY, "10000");
  storage.set(
    READER_DRAWER_STATE_STORAGE_KEY,
    JSON.stringify({ open: true, section: "history", updatedAt: 20_000 })
  );

  assert.equal(readInitialLayoutIntent().mode, "readerDrawer");
});

test("layout priority prefers dualThread over reader and reader over mindMap", () => {
  assert.equal(
    deriveLayoutMode({
      dualThreadOpen: true,
      readerOpen: true,
      readerType: "document",
      mindMapOpen: true,
    }),
    "dualThread"
  );
  assert.equal(
    deriveLayoutMode({
      readerOpen: true,
      readerType: "drawer",
      mindMapOpen: true,
    }),
    "readerDrawer"
  );
});

test("sidebar collapsed state is persisted per workspace", () => {
  installLocalStorageMock();

  applyWorkspaceLayoutStorageEvent({
    type: "SIDEBAR_TOGGLED",
    workspaceId: "ws-a",
    collapsed: true,
  });
  applyWorkspaceLayoutStorageEvent({
    type: "SIDEBAR_TOGGLED",
    workspaceId: "ws-b",
    collapsed: false,
  });

  assert.equal(readSidebarCollapsed("ws-a"), true);
  assert.equal(readSidebarCollapsed("ws-b"), false);
  assert.deepEqual(
    JSON.parse(
      localStorage.getItem(SIDEBAR_COLLAPSED_BY_WORKSPACE_STORAGE_KEY)
    ),
    { "ws-a": true, "ws-b": false }
  );
});

test("reader resize draft does not persist but commit writes once", () => {
  const storage = installLocalStorageMock();
  let writes = 0;
  const originalSet = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = (key, value) => {
    if (key === READER_SPLIT_PERCENT_STORAGE_KEY) writes += 1;
    originalSet(key, value);
  };

  applyWorkspaceLayoutStorageEvent({
    type: "READER_RESIZE_DRAFT",
    percent: 55,
  });
  assert.equal(writes, 0);

  applyWorkspaceLayoutStorageEvent({
    type: "READER_RESIZE_COMMIT",
    percent: 55,
  });
  assert.equal(writes, 1);
  assert.equal(storage.get(READER_SPLIT_PERCENT_STORAGE_KEY), "55");
});

test("layout reducer keeps resize draft in memory", () => {
  const state = workspaceLayoutReducer(
    { readerOpen: true, readerType: "drawer", readerPercent: 70 },
    { type: "READER_RESIZE_DRAFT", percent: 45 }
  );

  assert.equal(state.readerPercent, 45);
  assert.equal(state.mode, "readerDrawer");
});
