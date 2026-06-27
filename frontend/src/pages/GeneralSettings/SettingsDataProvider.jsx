import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
} from "react";
import System from "@/models/system";
import { requestPriorityQueue } from "@/utils/chat/requestPriorityQueue";

export const AI_PROVIDER_SETTING_SECTIONS = [
  "llm",
  "vector",
  "embedding",
  "rerank",
  "search",
  "ocr",
  "vision",
  "audio",
  "transcription",
];

const SettingsDataContext = createContext(null);
const STORAGE_KEY = "anythingllm_settings_section_cache_v1";
const CACHE_TTL_MS = 5 * 60 * 1000;
const memoryCache = new Map();
const inflightRequests = new Map();

function normalizeSections(sections = []) {
  const list = Array.isArray(sections) ? sections : [sections];
  return [
    ...new Set(list.map((section) => String(section).trim()).filter(Boolean)),
  ].sort();
}

function cacheKey(sections = []) {
  return normalizeSections(sections).join(",");
}

function safeReadStorage() {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(
      window.sessionStorage.getItem(STORAGE_KEY) || "{}"
    );
    return parsed?.sections && typeof parsed.sections === "object"
      ? parsed.sections
      : {};
  } catch {
    return {};
  }
}

function safeWriteStorage(sectionsCache) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, sections: sectionsCache })
    );
  } catch {
    // Section cache is an optimization. Quota failures must not block settings.
  }
}

function readSection(section) {
  const memoryHit = memoryCache.get(section);
  if (memoryHit) return memoryHit;

  const stored = safeReadStorage()[section];
  if (!stored) return null;
  memoryCache.set(section, stored);
  return stored;
}

function isFresh(entry) {
  return Boolean(
    entry?.settings && Date.now() - Number(entry.storedAt || 0) < CACHE_TTL_MS
  );
}

function mergeCachedSettings(sections) {
  const merged = {};
  for (const section of normalizeSections(sections)) {
    const entry = readSection(section);
    if (!isFresh(entry)) return null;
    Object.assign(merged, entry.settings || {});
  }
  return merged;
}

function storeSectionSettings(sections, settings, version = null) {
  if (!settings || typeof settings !== "object") return;
  const stored = safeReadStorage();
  const storedAt = Date.now();
  for (const section of normalizeSections(sections)) {
    const entry = { settings, version, storedAt };
    memoryCache.set(section, entry);
    stored[section] = entry;
  }
  safeWriteStorage(stored);
}

function clearSectionSettings(sections = null) {
  if (!sections) {
    memoryCache.clear();
    safeWriteStorage({});
    return;
  }

  const normalized = normalizeSections(sections);
  const stored = safeReadStorage();
  normalized.forEach((section) => {
    memoryCache.delete(section);
    delete stored[section];
  });
  safeWriteStorage(stored);
}

function requestIdle(fn) {
  if (typeof window === "undefined") return setTimeout(fn, 1);
  if ("requestIdleCallback" in window) {
    return window.requestIdleCallback(fn, { timeout: 2_500 });
  }
  return window.setTimeout(fn, 250);
}

export function SettingsDataProvider({ children }) {
  const loadSettings = useCallback(
    async (
      sections,
      { force = false, priority = "P1", signal = null } = {}
    ) => {
      const normalized = normalizeSections(sections);
      const key = cacheKey(normalized);
      if (!force) {
        const cached = mergeCachedSettings(normalized);
        if (cached) return { success: true, settings: cached, cached: true };
      }

      if (inflightRequests.has(key)) return inflightRequests.get(key);

      const task = async () => {
        const response = await System.settingsBootstrap({
          sections: normalized,
          signal,
        });
        if (response?.settings) {
          storeSectionSettings(normalized, response.settings, response.version);
        }
        return response;
      };

      const promise =
        priority === "P0"
          ? task()
          : requestPriorityQueue.schedule(task, {
              priority,
              signal,
              label: `settings:${key || "bootstrap"}`,
              dedupeKey: `settings:${key || "bootstrap"}`,
            });

      inflightRequests.set(key, promise);
      promise.finally(() => inflightRequests.delete(key));
      return promise;
    },
    []
  );

  const prewarmSettings = useCallback(
    (sections, options = {}) => {
      requestIdle(() => {
        loadSettings(sections, {
          priority: "P3",
          ...options,
        }).catch(() => null);
      });
    },
    [loadSettings]
  );

  const invalidateSettings = useCallback((sections = null) => {
    clearSectionSettings(sections);
    System.clearSettingsCache();
  }, []);

  const value = useMemo(
    () => ({
      loadSettings,
      prewarmSettings,
      invalidateSettings,
      cacheStats: () => ({
        memorySections: memoryCache.size,
        storedSections: Object.keys(safeReadStorage()).length,
      }),
    }),
    [invalidateSettings, loadSettings, prewarmSettings]
  );

  useEffect(() => {
    function handleInvalidation(event) {
      invalidateSettings(event?.detail?.sections || null);
    }
    window.addEventListener("settings-data-invalidated", handleInvalidation);
    window.__anythingSettingsData = value;
    return () => {
      window.removeEventListener(
        "settings-data-invalidated",
        handleInvalidation
      );
      if (window.__anythingSettingsData === value) {
        delete window.__anythingSettingsData;
      }
    };
  }, [invalidateSettings, value]);

  return (
    <SettingsDataContext.Provider value={value}>
      {children}
    </SettingsDataContext.Provider>
  );
}

export function useSettingsData() {
  const context = useContext(SettingsDataContext);
  if (!context) {
    return {
      loadSettings: async (sections) => System.settingsBootstrap({ sections }),
      prewarmSettings: () => {},
      invalidateSettings: () => System.clearSettingsCache(),
      cacheStats: () => ({ memorySections: 0, storedSections: 0 }),
    };
  }
  return context;
}

export function SettingsSectionSkeleton({ title, description }) {
  return (
    <div
      style={{ height: "calc(100% - 32px)" }}
      className="relative h-full w-full overflow-y-scroll bg-theme-bg-secondary p-4 md:my-[16px] md:ml-[2px] md:mr-[16px] md:rounded-[16px] md:p-0"
    >
      <div className="flex w-full flex-col px-1 py-16 md:py-6 md:pl-6 md:pr-[50px]">
        <div className="flex w-full flex-col gap-y-1 border-b-2 border-white border-opacity-10 pb-6 light:border-theme-sidebar-border">
          <p className="text-lg font-bold leading-6 text-white light:text-theme-text-primary">
            {title}
          </p>
          {description ? (
            <p className="text-xs leading-[18px] text-white text-opacity-60 light:text-theme-text-secondary">
              {description}
            </p>
          ) : null}
        </div>
        <div className="mt-8 flex w-full max-w-[720px] flex-col gap-y-4">
          <div className="h-16 animate-pulse rounded-lg bg-theme-settings-input-bg" />
          <div className="h-28 animate-pulse rounded-lg bg-theme-settings-input-bg" />
          <div className="h-10 w-2/3 animate-pulse rounded-lg bg-theme-settings-input-bg" />
        </div>
      </div>
    </div>
  );
}
