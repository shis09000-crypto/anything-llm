const DB_NAME = "anythingllm_reader_local_sources";
const DB_VERSION = 1;
const STORE_NAME = "sources";
const LOCAL_SOURCE_KIND = "file-handle";

function browserIndexedDb() {
  try {
    if (typeof indexedDB !== "undefined") return indexedDB;
    return globalThis?.indexedDB || null;
  } catch {
    return null;
  }
}

function randomId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function openDb() {
  const indexedDb = browserIndexedDb();
  if (!indexedDb) return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDb.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME))
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function transactionRequest(mode, callback) {
  return openDb().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) return resolve(null);
        const transaction = db.transaction(STORE_NAME, mode);
        const store = transaction.objectStore(STORE_NAME);
        let request = null;
        try {
          request = callback(store);
        } catch {
          db.close();
          return resolve(null);
        }
        request.onsuccess = () => resolve(request.result ?? true);
        request.onerror = () => resolve(null);
        transaction.oncomplete = () => db.close();
        transaction.onerror = () => db.close();
        transaction.onabort = () => db.close();
      })
  );
}

function compactText(value = "") {
  const text = String(value || "").trim();
  return text || null;
}

function itemLocalSourceId(item = {}) {
  return (
    compactText(item.localSourceId) ||
    compactText(item.key) ||
    compactText(item.readerDocumentId) ||
    compactText(item.backupReaderDocumentId) ||
    randomId()
  );
}

export function readerFileFingerprint(file = null) {
  if (!file) return null;
  return {
    name: file.name || null,
    size: Number.isFinite(file.size) ? file.size : null,
    lastModified: Number.isFinite(file.lastModified) ? file.lastModified : null,
  };
}

export function readerFileFingerprintsMatch(expected = null, actual = null) {
  if (!expected || !actual) return false;
  return (
    expected.name === actual.name &&
    expected.size === actual.size &&
    expected.lastModified === actual.lastModified
  );
}

export function readerLocalSourcePatch(source = null) {
  if (!source?.id) return null;
  return {
    localSourceId: source.id,
    localSourceKind: source.kind || LOCAL_SOURCE_KIND,
    localFingerprint: source.fingerprint || null,
  };
}

export async function saveReaderLocalSource({
  item = {},
  file = null,
  handle,
}) {
  if (!file || !handle) return null;
  const id = itemLocalSourceId(item);
  const source = {
    id,
    kind: LOCAL_SOURCE_KIND,
    handle,
    fingerprint: readerFileFingerprint(file),
    title: item.title || file.name || null,
    readerDocumentId:
      item.readerDocumentId || item.backupReaderDocumentId || null,
    savedAt: new Date().toISOString(),
  };
  const saved = await transactionRequest("readwrite", (store) =>
    store.put(source)
  );
  return saved ? readerLocalSourcePatch(source) : null;
}

export async function getReaderLocalSource(localSourceId) {
  if (!localSourceId) return null;
  return await transactionRequest("readonly", (store) =>
    store.get(localSourceId)
  );
}

async function ensureReadPermission(handle) {
  if (!handle) return false;
  try {
    if (typeof handle.queryPermission === "function") {
      const current = await handle.queryPermission({ mode: "read" });
      if (current === "granted") return true;
    }
    if (typeof handle.requestPermission === "function") {
      const requested = await handle.requestPermission({ mode: "read" });
      return requested === "granted";
    }
    return true;
  } catch {
    return false;
  }
}

export async function openReaderLocalSource(item = {}) {
  const source = await getReaderLocalSource(item.localSourceId);
  if (!source?.handle) {
    return { ok: false, reason: "missing" };
  }

  const permitted = await ensureReadPermission(source.handle);
  if (!permitted) {
    return { ok: false, reason: "permission-denied" };
  }

  try {
    const file = await source.handle.getFile();
    const actualFingerprint = readerFileFingerprint(file);
    const expectedFingerprint = item.localFingerprint || source.fingerprint;
    if (
      expectedFingerprint &&
      !readerFileFingerprintsMatch(expectedFingerprint, actualFingerprint)
    ) {
      return { ok: false, reason: "fingerprint-mismatch" };
    }

    return {
      ok: true,
      file,
      source: {
        ...source,
        fingerprint: actualFingerprint,
      },
    };
  } catch {
    return { ok: false, reason: "file-unavailable" };
  }
}

export async function deleteReaderLocalSources(items = []) {
  const ids = [
    ...new Set(
      (Array.isArray(items) ? items : [items])
        .map((item) => item?.localSourceId)
        .filter(Boolean)
    ),
  ];
  if (!ids.length) return;
  await transactionRequest("readwrite", (store) => {
    for (const id of ids) store.delete(id);
    return store.get(ids[0]);
  });
}
