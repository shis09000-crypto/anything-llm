import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { useLocation } from "react-router-dom";
import System from "@/models/system";
import { requestPriorityQueue } from "@/utils/chat/requestPriorityQueue";
import { recordCommunicationEvent } from "@/lib/communication/communicationMetrics";
import { useSoftSettingsShell } from "@/components/SoftSettings/context";
import {
  allAiProviderSections,
  isPersistentSettingsRoute,
  settingsSectionsForPath,
} from "@/utils/settingsRoutes";

export const AI_PROVIDER_SETTING_SECTIONS = allAiProviderSections();

const SettingsDataContext = createContext(null);
const STORAGE_KEY = "anythingllm_settings_section_cache_v1";
const CACHE_TTL_MS = 10 * 60 * 1000;
const memoryCache = new Map();
const inflightRequests = new Map();
const SETTINGS_PREWARM_LABEL_PREFIX = "settings:prewarm:";

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

function cancelIdle(handle) {
  if (handle === null || handle === undefined || typeof window === "undefined")
    return;
  if ("cancelIdleCallback" in window) window.cancelIdleCallback(handle);
  window.clearTimeout(handle);
}

function linkAbortSignal(controller, signal) {
  if (!signal) return () => {};
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) {
    abort();
    return () => {};
  }
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

export function SettingsDataProvider({ children }) {
  const location = useLocation();
  const routeStateRef = useRef({
    generation: 0,
    pathname: location.pathname,
    sections: settingsSectionsForPath(location.pathname),
    isPersistentSettings: isPersistentSettingsRoute(location.pathname),
  });
  const activeCurrentRequestRef = useRef(null);
  const backgroundPrewarmRef = useRef({
    idleHandle: null,
    controller: null,
  });

  const loadSettings = useCallback(
    async (
      sections,
      { force = false, priority = "P1", signal = null, prewarm = false } = {}
    ) => {
      const normalized = normalizeSections(sections);
      const key = cacheKey(normalized);
      const routeState = routeStateRef.current;
      const isCurrentRouteRequest =
        priority === "P0" &&
        routeState.isPersistentSettings &&
        routeState.sections.length > 0 &&
        normalized.some((section) => routeState.sections.includes(section));
      const requestGeneration = routeState.generation;

      if (!force) {
        const cached = mergeCachedSettings(normalized);
        if (cached) {
          recordSettingsCacheEvent("hit", key);
          return { success: true, settings: cached, cached: true };
        }
      }

      if (inflightRequests.has(key)) {
        recordSettingsCacheEvent("dedupe", key);
        return inflightRequests.get(key);
      }
      recordSettingsCacheEvent(force ? "refresh" : "miss", key);

      let currentAbortController = null;
      let abortCleanup = () => {};
      let requestSignal = signal;
      if (isCurrentRouteRequest) {
        const previous = activeCurrentRequestRef.current;
        if (previous?.controller && previous.key !== key) {
          previous.controller.abort();
          inflightRequests.delete(previous.key);
        }

        currentAbortController = new AbortController();
        abortCleanup = linkAbortSignal(currentAbortController, signal);
        requestSignal = currentAbortController.signal;
        activeCurrentRequestRef.current = {
          controller: currentAbortController,
          generation: requestGeneration,
          key,
        };
      }

      const task = async () => {
        const startedAt = performance.now();
        let response = null;
        try {
          response = await System.settingsBootstrap({
            sections: normalized,
            signal: requestSignal,
          });
        } catch (error) {
          if (error?.name === "AbortError") {
            recordSettingsCacheEvent("aborted", key);
            return { success: false, settings: null, aborted: true };
          }
          throw error;
        } finally {
          abortCleanup();
        }

        if (
          isCurrentRouteRequest &&
          routeStateRef.current.generation !== requestGeneration
        ) {
          recordSettingsCacheEvent("stale", key, {
            durationMs: Math.round(performance.now() - startedAt),
          });
          return { success: false, settings: null, stale: true };
        }

        if (response?.settings) {
          storeSectionSettings(normalized, response.settings, response.version);
        }
        recordSettingsCacheEvent("loaded", key, {
          durationMs: Math.round(performance.now() - startedAt),
        });
        return response;
      };

      const label = `${prewarm ? SETTINGS_PREWARM_LABEL_PREFIX : "settings:"}${
        key || "bootstrap"
      }`;
      const promise = requestPriorityQueue.schedule(task, {
        priority,
        signal: requestSignal,
        label,
        dedupeKey: label,
        kind: "settings",
        scope: {
          route: "settings",
          pathname: routeState.pathname,
          sections: key,
        },
        policy: prewarm
          ? "maintenance"
          : priority === "P0"
            ? "foreground"
            : "background",
        emergency: isCurrentRouteRequest,
      });

      inflightRequests.set(key, promise);
      const cleanupInflight = () => {
        inflightRequests.delete(key);
        const current = activeCurrentRequestRef.current;
        if (current?.key === key && current?.generation === requestGeneration) {
          activeCurrentRequestRef.current = null;
        }
      };
      promise.then(cleanupInflight, cleanupInflight);
      return promise;
    },
    []
  );

  const prewarmSettings = useCallback(
    (sections, options = {}) => {
      const idleHandle = requestIdle(() => {
        if (options.signal?.aborted) return;
        loadSettings(sections, {
          priority: "P4",
          prewarm: true,
          ...options,
        }).catch(() => null);
      });
      return () => cancelIdle(idleHandle);
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
    const pathname = location.pathname;
    const sections = settingsSectionsForPath(pathname);
    const isPersistentSettings = isPersistentSettingsRoute(pathname);
    const previousRouteState = routeStateRef.current;
    const routeChanged = previousRouteState.pathname !== pathname;
    routeStateRef.current = {
      generation: routeChanged
        ? previousRouteState.generation + 1
        : previousRouteState.generation,
      pathname,
      sections,
      isPersistentSettings,
    };

    if (routeChanged) {
      const current = activeCurrentRequestRef.current;
      if (current?.controller) {
        current.controller.abort();
        inflightRequests.delete(current.key);
        activeCurrentRequestRef.current = null;
      }
    }

    const background = backgroundPrewarmRef.current;
    cancelIdle(background.idleHandle);
    background.controller?.abort();
    backgroundPrewarmRef.current = {
      idleHandle: null,
      controller: null,
    };

    requestPriorityQueue.clear((entry) => {
      if (!String(entry.label || "").startsWith(SETTINGS_PREWARM_LABEL_PREFIX))
        return false;
      return ["P3", "P4"].includes(entry.priority);
    });

    if (!isPersistentSettings) return;

    const controller = new AbortController();
    const idleHandle = requestIdle(() => {
      const latest = routeStateRef.current;
      if (latest.pathname !== pathname || controller.signal.aborted) return;
      const backgroundSections = AI_PROVIDER_SETTING_SECTIONS.filter(
        (section) => !sections.includes(section)
      );
      if (!backgroundSections.length) return;
      loadSettings(backgroundSections, {
        priority: "P4",
        signal: controller.signal,
        prewarm: true,
      }).catch(() => null);
    });

    backgroundPrewarmRef.current = {
      idleHandle,
      controller,
    };

    return () => {
      cancelIdle(idleHandle);
      controller.abort();
    };
  }, [loadSettings, location.pathname]);

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

function recordSettingsCacheEvent(action, key, extra = {}) {
  recordCommunicationEvent({
    type: "settings-cache",
    method: "CACHE",
    path: `settings:${key || "bootstrap"}`,
    communicationScene: "model-settings",
    cache: action,
    durationMs: extra.durationMs || 0,
    requestBytes: 0,
    responseBytes: 0,
    ok: true,
  });
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
  const hasPersistentSettingsShell = useSoftSettingsShell();

  if (hasPersistentSettingsShell) {
    return (
      <div className="settings-soft-content">
        <header className="settings-soft-header">
          <div className="min-w-0">
            <div className="h-8 w-56 animate-pulse rounded-xl bg-slate-200" />
            {description ? (
              <div className="mt-3 h-4 w-full max-w-[560px] animate-pulse rounded-full bg-slate-200/80" />
            ) : null}
          </div>
        </header>
        <section className="settings-soft-card">
          <div className="h-16 animate-pulse rounded-2xl border border-slate-200 bg-slate-50" />
          <div className="mt-4 h-28 animate-pulse rounded-2xl border border-slate-200 bg-slate-50" />
          <div className="mt-4 h-10 w-2/3 animate-pulse rounded-xl border border-slate-200 bg-slate-50" />
        </section>
      </div>
    );
  }

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
