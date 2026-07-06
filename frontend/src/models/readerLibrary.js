import {
  deleteJson,
  getJson,
  patchJson,
  postJson,
} from "@/lib/communication/apiClient";
import { getAppEnvironment } from "@/utils/appEnvironment";
import { getStoredAuthUser } from "@/utils/authUserStorage";
import { serverStateCache } from "@/utils/serverState/serverStateCache";
import { serverStateTaskBridge } from "@/utils/serverState/serverStateTaskBridge";

const READER_LIBRARY_TTL_MS = 1000 * 60 * 5;
const READER_LIBRARY_KEY = "reader.library";

function currentUserScope() {
  if (typeof window === "undefined") return "server";
  const user = getStoredAuthUser();
  return [
    getAppEnvironment(),
    user?.authUserId || user?.id || user?.username || "anonymous",
  ].join(":");
}

function libraryScope(extra = {}) {
  return {
    domain: "reader-data-authority",
    route: "workspace-chat",
    surface: "reader-library",
    ...extra,
  };
}

function taskMeta(options = {}, fallback = {}) {
  return {
    kind: "reader",
    scope: libraryScope(options.scope || {}),
    priority: options.priority || fallback.priority || "P0",
    policy: options.policy || fallback.policy || "foreground",
    intentRank: options.intentRank ?? fallback.intentRank ?? 1,
    emergency: options.emergency ?? fallback.emergency ?? true,
    protected: options.protected ?? fallback.protected ?? false,
    resource: options.resource || fallback.resource || "network",
    label: options.label || fallback.label || "reader:library-authority",
    dedupeKey:
      options.dedupeKey ||
      fallback.dedupeKey ||
      `server-state:${READER_LIBRARY_KEY}`,
  };
}

function normalizeLibrary(data = {}) {
  return {
    success: data?.success !== false,
    revision: data?.revision || null,
    categories: Array.isArray(data?.categories) ? data.categories : [],
    bookshelf: Array.isArray(data?.bookshelf) ? data.bookshelf : [],
    counts: data?.counts || {
      categories: Array.isArray(data?.categories) ? data.categories.length : 0,
      bookshelf: Array.isArray(data?.bookshelf) ? data.bookshelf.length : 0,
    },
  };
}

function setLibrary(data = {}, meta = {}) {
  const normalized = normalizeLibrary(data);
  serverStateCache.set(READER_LIBRARY_KEY, normalized, {
    ttlMs: READER_LIBRARY_TTL_MS,
    ownerScope: currentUserScope(),
    scope: libraryScope(meta.scope || {}),
    meta: {
      revision: normalized.revision,
      count: normalized.bookshelf.length,
    },
  });
  return normalized;
}

const ReaderLibrary = {
  key: READER_LIBRARY_KEY,
  ttlMs: READER_LIBRARY_TTL_MS,

  cached(options = {}) {
    return serverStateCache.get(READER_LIBRARY_KEY, {
      allowStale: options.allowStale !== false,
      ttlMs: READER_LIBRARY_TTL_MS,
      ownerScope: currentUserScope(),
    });
  },

  async list(options = {}) {
    const data = await serverStateTaskBridge.ensure({
      key: READER_LIBRARY_KEY,
      fetcher: async ({ signal }) => {
        const result = await getJson("/reader-library", {
          signal,
          task: false,
          communicationScene: "reader-visible",
        });
        return normalizeLibrary(result.data);
      },
      ttlMs: READER_LIBRARY_TTL_MS,
      ownerScope: currentUserScope(),
      scope: libraryScope(options.scope || {}),
      priority: options.priority || "P0",
      policy: options.policy || "foreground",
      intentRank: options.intentRank ?? 1,
      staleWhileRevalidate: options.staleWhileRevalidate !== false,
      dedupeKey: `server-state:${READER_LIBRARY_KEY}`,
      signal: options.signal,
      label: options.label || "reader:library-authority",
      onCommit: (library) => setLibrary(library, options),
    });
    return {
      response: new Response(null, { status: 200 }),
      data: normalizeLibrary(data),
    };
  },

  async bootstrap(payload = {}, options = {}) {
    const { response, data } = await postJson(
      "/reader-library/bootstrap",
      payload,
      {
        signal: options.signal,
        communicationScene: "reader-visible",
        task: taskMeta(options, {
          label: "reader:library-bootstrap",
          protected: true,
        }),
      }
    );
    if (response.ok && data?.success) setLibrary(data, options);
    return { response, data: normalizeLibrary(data) };
  },

  async patchItem(itemId, patch = {}, options = {}) {
    const { response, data } = await patchJson(
      `/reader-library/items/${encodeURIComponent(itemId)}`,
      patch,
      {
        signal: options.signal,
        communicationScene: "reader-visible",
        task: taskMeta(options, {
          label: "reader:library-item-patch",
          protected: true,
        }),
      }
    );
    if (response.ok && data?.success) setLibrary(data, options);
    return { response, data: normalizeLibrary(data) };
  },

  async deleteItem(itemId, options = {}) {
    const { response, data } = await deleteJson(
      `/reader-library/items/${encodeURIComponent(itemId)}`,
      {
        signal: options.signal,
        communicationScene: "reader-visible",
        task: taskMeta(options, {
          label: "reader:library-item-delete",
          protected: true,
        }),
      }
    );
    if (response.ok && data?.success) setLibrary(data, options);
    return { response, data: normalizeLibrary(data) };
  },

  async patchCategory(categoryId, patch = {}, options = {}) {
    const { response, data } = await patchJson(
      `/reader-library/categories/${encodeURIComponent(categoryId)}`,
      patch,
      {
        signal: options.signal,
        communicationScene: "reader-visible",
        task: taskMeta(options, {
          label: "reader:library-category-patch",
          protected: true,
        }),
      }
    );
    if (response.ok && data?.success) setLibrary(data, options);
    return { response, data: normalizeLibrary(data) };
  },

  async deleteCategory(categoryId, options = {}) {
    const { response, data } = await deleteJson(
      `/reader-library/categories/${encodeURIComponent(categoryId)}`,
      {
        signal: options.signal,
        communicationScene: "reader-visible",
        task: taskMeta(options, {
          label: "reader:library-category-delete",
          protected: true,
        }),
      }
    );
    if (response.ok && data?.success) setLibrary(data, options);
    return { response, data: normalizeLibrary(data) };
  },

  async reconcile(payload = {}, options = {}) {
    const { response, data } = await postJson(
      "/reader-library/reconcile",
      payload,
      {
        signal: options.signal,
        communicationScene: "reader-visible",
        task: taskMeta(options, {
          priority: options.priority || "P1",
          intentRank: options.intentRank ?? 2,
          label: "reader:library-reconcile",
        }),
      }
    );
    if (response.ok && data?.success) setLibrary(data, options);
    return { response, data: normalizeLibrary(data) };
  },

  invalidate() {
    return serverStateCache.invalidate(READER_LIBRARY_KEY, {
      ownerScope: currentUserScope(),
    });
  },
};

export default ReaderLibrary;
