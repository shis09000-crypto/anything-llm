import { getAppEnvironment } from "../appEnvironment.js";
import { getStoredAuthUser } from "../authUserStorage.js";
import { serverStateCache } from "./serverStateCache.js";
import { serverStateTaskBridge } from "./serverStateTaskBridge.js";

export const READER_SERVER_STATE_TTL_MS = 1000 * 60 * 5;

export const READER_SERVER_STATE_KEYS = {
  documents: (workspaceSlug = null) =>
    workspaceSlug
      ? `reader.documents:workspace:${workspaceSlug}`
      : "reader.documents:global",
  document: (workspaceSlug = null, readerDocumentId) =>
    `reader.document:${workspaceSlug || "global"}:${readerDocumentId}`,
};

function clone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function currentUserScope() {
  if (typeof window === "undefined") return "server";
  const user = getStoredAuthUser();
  return [
    getAppEnvironment(),
    user?.authUserId || user?.id || user?.username || "anonymous",
  ].join(":");
}

function readerScope(workspaceSlug = null, extra = {}) {
  return {
    domain: "reader-server-state",
    route: "workspace-chat",
    workspaceSlug: workspaceSlug || null,
    ...extra,
  };
}

function stripLargeReaderPayload(value) {
  if (!value || typeof value !== "object") return value;
  const next = { ...value };
  [
    "sensitiveSession",
    "content",
    "text",
    "rawText",
    "extractedText",
    "pages",
    "pageText",
    "objectUrl",
    "blobUrl",
    "file",
  ].forEach((key) => delete next[key]);

  if (next.metadata && typeof next.metadata === "object") {
    next.metadata = { ...next.metadata };
    delete next.metadata.sensitiveSession;
    delete next.metadata.localPath;
    delete next.metadata.absolutePath;
  }

  return next;
}

function readerDocumentIdFor(documentData) {
  return (
    documentData?.metadata?.readerDocumentId ||
    documentData?.readerDocumentId ||
    documentData?.id ||
    null
  );
}

function withReaderDocumentWorkspaceSlug(documentData, workspaceSlug = null) {
  if (!documentData || !workspaceSlug) return documentData;
  const next = clone(documentData);
  const metadata =
    next.metadata && typeof next.metadata === "object" ? next.metadata : {};
  next.metadata = {
    ...metadata,
    readerDocumentWorkspaceSlug:
      metadata.readerDocumentWorkspaceSlug ||
      next.readerDocumentWorkspaceSlug ||
      workspaceSlug,
  };
  next.readerDocumentWorkspaceSlug =
    next.readerDocumentWorkspaceSlug ||
    next.metadata.readerDocumentWorkspaceSlug ||
    workspaceSlug;
  return next;
}

function sanitizeDocument(documentData, workspaceSlug = null) {
  const withWorkspace = withReaderDocumentWorkspaceSlug(
    documentData,
    workspaceSlug
  );
  const sanitized = stripLargeReaderPayload(clone(withWorkspace));
  return sanitized || null;
}

function sanitizeDocuments(documents = [], workspaceSlug = null) {
  return (Array.isArray(documents) ? documents : [])
    .map((documentData) => sanitizeDocument(documentData, workspaceSlug))
    .filter(Boolean);
}

function updateList(workspaceSlug, updater) {
  const key = READER_SERVER_STATE_KEYS.documents(workspaceSlug);
  const current =
    serverStateCache.get(key, {
      allowStale: true,
      ttlMs: READER_SERVER_STATE_TTL_MS,
      ownerScope: currentUserScope(),
    }) || [];
  const next = updater(Array.isArray(current) ? current : []);
  setDocumentList(workspaceSlug, next);
  return next;
}

function setDocumentList(workspaceSlug = null, documents = []) {
  const sanitized = sanitizeDocuments(documents, workspaceSlug);
  serverStateCache.set(
    READER_SERVER_STATE_KEYS.documents(workspaceSlug),
    sanitized,
    {
      ttlMs: READER_SERVER_STATE_TTL_MS,
      ownerScope: currentUserScope(),
      scope: readerScope(workspaceSlug, { surface: "document-list" }),
      meta: { count: sanitized.length },
    }
  );
  sanitized.forEach((documentData) => setDocument(workspaceSlug, documentData));
  return sanitized;
}

function setDocument(workspaceSlug = null, documentData = null) {
  const readerDocumentId = readerDocumentIdFor(documentData);
  if (!readerDocumentId) return null;
  const sanitized = sanitizeDocument(documentData, workspaceSlug);
  serverStateCache.set(
    READER_SERVER_STATE_KEYS.document(workspaceSlug, readerDocumentId),
    sanitized,
    {
      ttlMs: READER_SERVER_STATE_TTL_MS,
      ownerScope: currentUserScope(),
      scope: readerScope(workspaceSlug, {
        surface: "document-detail",
        readerDocumentId,
      }),
      meta: {
        documentType:
          sanitized?.metadata?.documentType ||
          sanitized?.contentSummary?.documentType ||
          sanitized?.documentType ||
          null,
      },
    }
  );
  return sanitized;
}

export const readerServerStateStore = {
  ownerScope: currentUserScope,
  ttlMs: READER_SERVER_STATE_TTL_MS,
  keys: READER_SERVER_STATE_KEYS,

  getDocumentList(workspaceSlug = null, options = {}) {
    return serverStateCache.get(
      READER_SERVER_STATE_KEYS.documents(workspaceSlug),
      {
        allowStale: options.allowStale !== false,
        ttlMs: READER_SERVER_STATE_TTL_MS,
        ownerScope: currentUserScope(),
      }
    );
  },

  setDocumentList,

  ensureDocumentList(workspaceSlug = null, fetcher, options = {}) {
    return serverStateTaskBridge.ensure({
      key: READER_SERVER_STATE_KEYS.documents(workspaceSlug),
      fetcher: async (taskArgs) =>
        sanitizeDocuments(await fetcher(taskArgs), workspaceSlug),
      ttlMs: READER_SERVER_STATE_TTL_MS,
      ownerScope: currentUserScope(),
      scope: readerScope(workspaceSlug, { surface: "document-list" }),
      priority: options.priority || "P1",
      intentRank: options.intentRank ?? 3,
      policy: options.policy || "visible",
      staleWhileRevalidate: options.staleWhileRevalidate !== false,
      dedupeKey:
        options.dedupeKey ||
        `server-state:${READER_SERVER_STATE_KEYS.documents(workspaceSlug)}`,
      signal: options.signal,
      label: options.label || `reader:documents:${workspaceSlug || "global"}`,
      meta: options.meta,
      onCommit: (documents) => {
        sanitizeDocuments(documents, workspaceSlug).forEach((documentData) =>
          setDocument(workspaceSlug, documentData)
        );
      },
    });
  },

  getDocument(workspaceSlug = null, readerDocumentId, options = {}) {
    if (!readerDocumentId) return null;
    return serverStateCache.get(
      READER_SERVER_STATE_KEYS.document(workspaceSlug, readerDocumentId),
      {
        allowStale: options.allowStale !== false,
        ttlMs: READER_SERVER_STATE_TTL_MS,
        ownerScope: currentUserScope(),
      }
    );
  },

  setDocument,

  ensureDocument(
    workspaceSlug = null,
    readerDocumentId,
    fetcher,
    options = {}
  ) {
    if (!readerDocumentId) return Promise.resolve(null);
    return serverStateTaskBridge.ensure({
      key: READER_SERVER_STATE_KEYS.document(workspaceSlug, readerDocumentId),
      fetcher: async (taskArgs) =>
        sanitizeDocument(await fetcher(taskArgs), workspaceSlug),
      ttlMs: READER_SERVER_STATE_TTL_MS,
      ownerScope: currentUserScope(),
      scope: readerScope(workspaceSlug, {
        surface: "document-detail",
        readerDocumentId,
      }),
      priority: options.priority || "P0",
      intentRank: options.intentRank ?? 0,
      policy: options.policy || "foreground",
      staleWhileRevalidate: options.staleWhileRevalidate !== false,
      dedupeKey:
        options.dedupeKey ||
        `server-state:${READER_SERVER_STATE_KEYS.document(
          workspaceSlug,
          readerDocumentId
        )}`,
      signal: options.signal,
      label: options.label || `reader:document:${readerDocumentId}`,
      meta: options.meta,
      onCommit: (documentData) => {
        const sanitized = sanitizeDocument(documentData, workspaceSlug);
        const committedReaderDocumentId = readerDocumentIdFor(sanitized);
        if (!committedReaderDocumentId) return;
        updateList(workspaceSlug, (documents) => {
          const exists = documents.some(
            (item) => readerDocumentIdFor(item) === committedReaderDocumentId
          );
          if (!exists) return [sanitized, ...documents];
          return documents.map((item) =>
            readerDocumentIdFor(item) === committedReaderDocumentId
              ? { ...item, ...sanitized }
              : item
          );
        });
      },
    });
  },

  upsertDocument(workspaceSlug = null, documentData = null) {
    const readerDocumentId = readerDocumentIdFor(documentData);
    if (!readerDocumentId) return null;
    const sanitized = setDocument(workspaceSlug, documentData);
    updateList(workspaceSlug, (documents) => {
      const exists = documents.some(
        (item) => readerDocumentIdFor(item) === readerDocumentId
      );
      if (!exists) return [sanitized, ...documents];
      return documents.map((item) =>
        readerDocumentIdFor(item) === readerDocumentId
          ? { ...item, ...sanitized }
          : item
      );
    });
    return sanitized;
  },

  removeDocument(workspaceSlug = null, readerDocumentId = null) {
    if (!readerDocumentId) return 0;
    const ownerScope = currentUserScope();
    let removed = 0;
    const workspaceTargets = new Set([workspaceSlug || null]);
    serverStateCache.snapshot().entries.forEach((entry) => {
      if (
        entry.ownerScope === ownerScope &&
        entry.scope?.domain === "reader-server-state" &&
        entry.scope?.surface === "document-list"
      ) {
        workspaceTargets.add(entry.scope.workspaceSlug || null);
      }
    });
    workspaceTargets.forEach((targetWorkspaceSlug) => {
      updateList(targetWorkspaceSlug, (documents) =>
        documents.filter(
          (documentData) =>
            readerDocumentIdFor(documentData) !== readerDocumentId
        )
      );
      removed += serverStateCache.invalidate(
        READER_SERVER_STATE_KEYS.document(
          targetWorkspaceSlug,
          readerDocumentId
        ),
        { ownerScope }
      );
    });
    return removed;
  },

  invalidateDocumentList(workspaceSlug = null) {
    return serverStateCache.invalidate(
      READER_SERVER_STATE_KEYS.documents(workspaceSlug),
      { ownerScope: currentUserScope() }
    );
  },

  invalidateDocument(workspaceSlug = null, readerDocumentId = null) {
    if (!readerDocumentId) return 0;
    return serverStateCache.invalidate(
      READER_SERVER_STATE_KEYS.document(workspaceSlug, readerDocumentId),
      { ownerScope: currentUserScope() }
    );
  },

  invalidateWorkspace(workspaceSlug = null) {
    return serverStateCache.invalidateScope(
      {
        domain: "reader-server-state",
        workspaceSlug: workspaceSlug || null,
      },
      { ownerScope: currentUserScope() }
    );
  },

  stats() {
    const ownerScope = currentUserScope();
    const entries = serverStateCache
      .snapshot()
      .entries.filter(
        (entry) =>
          entry.ownerScope === ownerScope &&
          entry.scope?.domain === "reader-server-state"
      );
    return {
      documentListCount: entries.filter(
        (entry) => entry.scope?.surface === "document-list"
      ).length,
      documentDetailCount: entries.filter(
        (entry) => entry.scope?.surface === "document-detail"
      ).length,
      serverStateEntries: entries,
    };
  },
};
