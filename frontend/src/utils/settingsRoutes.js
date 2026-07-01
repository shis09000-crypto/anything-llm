export const SETTINGS_SOFT_SURFACE_KEY = "/settings-soft-surface";

const SETTINGS_PATH_PREFIX = "/settings/";
const PERSISTENT_SETTINGS_EXCLUDED_PATHS = [
  "/settings/account",
  "/settings/agents/builder",
  "/settings/community-hub",
  "/settings/crypto-center",
];

export const AI_PROVIDER_ROUTE_SECTIONS = {
  "/settings/llm-preference": ["llm"],
  "/settings/vector-database": ["vector"],
  "/settings/embedding-preference": ["embedding"],
  "/settings/rerank-preference": ["rerank"],
  "/settings/search-model-preference": ["search"],
  "/settings/ocr-preference": ["ocr"],
  "/settings/vision-preference": ["vision"],
  "/settings/audio-preference": ["audio"],
  "/settings/transcription-preference": ["transcription"],
};

export function isPersistentSettingsRoute(pathname = "") {
  const normalized = normalizePathname(pathname);
  if (!normalized.startsWith(SETTINGS_PATH_PREFIX)) return false;
  return !PERSISTENT_SETTINGS_EXCLUDED_PATHS.some(
    (path) => normalized === path || normalized.startsWith(`${path}/`)
  );
}

export function settingsSectionsForPath(pathname = "") {
  const normalized = normalizePathname(pathname);
  return AI_PROVIDER_ROUTE_SECTIONS[normalized] || [];
}

export function allAiProviderSections() {
  return [...new Set(Object.values(AI_PROVIDER_ROUTE_SECTIONS).flat())];
}

function normalizePathname(pathname = "") {
  const pathOnly =
    String(pathname || "")
      .split("?")[0]
      .split("#")[0] || "/";
  if (pathOnly.length > 1 && pathOnly.endsWith("/")) {
    return pathOnly.slice(0, -1);
  }
  return pathOnly;
}
