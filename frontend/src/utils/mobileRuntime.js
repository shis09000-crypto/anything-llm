export const ATHENA_FORCE_MOBILE_STORAGE_KEY = "athena_force_mobile_runtime_v1";
export const ATHENA_FORCE_MOBILE_PLATFORM_STORAGE_KEY =
  "athena_force_mobile_platform_v1";

const MOBILE_QUERY_PARAMS = ["athenaMobile", "mobile"];
const MOBILE_PLATFORM_QUERY_PARAM = "athenaPlatform";
const TRUE_TOKENS = new Set(["1", "true", "yes", "on", "mobile"]);
const FALSE_TOKENS = new Set(["0", "false", "no", "off", "desktop"]);
const MOBILE_PLATFORMS = new Set(["ios", "android"]);

function safeWindow(win = undefined) {
  if (win) return win;
  return typeof window === "undefined" ? null : window;
}

function safeSessionStorage(win = safeWindow()) {
  try {
    return win?.sessionStorage || null;
  } catch {
    return null;
  }
}

function queryParams(win = safeWindow()) {
  const location = win?.location;
  if (!location) return null;
  try {
    return new URL(location.href).searchParams;
  } catch {
    try {
      return new URLSearchParams(location.search || "");
    } catch {
      return null;
    }
  }
}

function normalizeBooleanToken(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (TRUE_TOKENS.has(normalized)) return true;
  if (FALSE_TOKENS.has(normalized)) return false;
  return null;
}

function normalizePlatform(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return MOBILE_PLATFORMS.has(normalized) ? normalized : null;
}

function urlMobileOverride(win = safeWindow()) {
  const params = queryParams(win);
  if (!params) return null;

  for (const name of MOBILE_QUERY_PARAMS) {
    if (!params.has(name)) continue;
    const parsed = normalizeBooleanToken(params.get(name));
    if (parsed !== null) return parsed;
  }
  return null;
}

function urlPlatformOverride(win = safeWindow()) {
  return normalizePlatform(queryParams(win)?.get(MOBILE_PLATFORM_QUERY_PARAM));
}

export function syncMobileRuntimeOverrideFromUrl(win = safeWindow()) {
  const storage = safeSessionStorage(win);
  const override = urlMobileOverride(win);
  const platform = urlPlatformOverride(win);

  if (override === true) {
    storage?.setItem(ATHENA_FORCE_MOBILE_STORAGE_KEY, "true");
    if (platform) {
      storage?.setItem(ATHENA_FORCE_MOBILE_PLATFORM_STORAGE_KEY, platform);
    }
    return true;
  }

  if (override === false) {
    storage?.removeItem(ATHENA_FORCE_MOBILE_STORAGE_KEY);
    storage?.removeItem(ATHENA_FORCE_MOBILE_PLATFORM_STORAGE_KEY);
    return false;
  }

  if (platform) {
    storage?.setItem(ATHENA_FORCE_MOBILE_PLATFORM_STORAGE_KEY, platform);
  }

  return storage?.getItem(ATHENA_FORCE_MOBILE_STORAGE_KEY) === "true"
    ? true
    : null;
}

export function mobileRuntimeForced(win = safeWindow()) {
  const synced = syncMobileRuntimeOverrideFromUrl(win);
  if (synced === true) return true;
  if (synced === false) return false;
  return (
    safeSessionStorage(win)?.getItem(ATHENA_FORCE_MOBILE_STORAGE_KEY) === "true"
  );
}

export const isMobileRuntimeForced = mobileRuntimeForced;

export function forcedMobilePlatform(win = safeWindow()) {
  if (!mobileRuntimeForced(win)) return null;

  const platform =
    urlPlatformOverride(win) ||
    normalizePlatform(
      safeSessionStorage(win)?.getItem(ATHENA_FORCE_MOBILE_PLATFORM_STORAGE_KEY)
    );
  return platform || "ios";
}

function mediaMatches(win, query) {
  try {
    return !!win?.matchMedia?.(query)?.matches;
  } catch {
    return false;
  }
}

function safeNavigator(win = safeWindow()) {
  return (
    win?.navigator || (typeof navigator === "undefined" ? null : navigator)
  );
}

function viewportWidth(win = safeWindow()) {
  const widths = [
    win?.innerWidth,
    win?.visualViewport?.width,
    win?.document?.documentElement?.clientWidth,
    win?.screen?.width,
  ]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  return widths.length ? Math.min(...widths) : 0;
}

export function detectIPadLikeNavigator(win = safeWindow()) {
  const nav = safeNavigator(win);
  if (!nav) return false;

  const userAgent = nav.userAgent || "";
  const platform = nav.platform || "";
  const maxTouchPoints = Number(nav.maxTouchPoints || 0);
  return (
    /ipad/i.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1)
  );
}

export function detectTabletRuntimeFromNavigator(win = safeWindow()) {
  const nav = safeNavigator(win);
  if (!nav) return false;

  const userAgent = nav.userAgent || "";
  if (detectIPadLikeNavigator(win)) return true;

  const width = viewportWidth(win);
  const maxTouchPoints = Number(nav.maxTouchPoints || 0);
  const coarsePointer =
    mediaMatches(win, "(pointer: coarse)") ||
    mediaMatches(win, "(any-pointer: coarse)");
  if (/android/i.test(userAgent)) {
    return !/mobile|mobi/i.test(userAgent);
  }

  return (
    nav.userAgentData?.mobile === false &&
    maxTouchPoints > 0 &&
    coarsePointer &&
    width >= 768
  );
}

export function detectPhoneRuntimeFromNavigator(win = safeWindow()) {
  const nav = safeNavigator(win);
  if (!nav) return false;
  if (detectTabletRuntimeFromNavigator(win)) return false;

  const userAgent = nav.userAgent || "";
  if (nav.userAgentData?.mobile === true) return true;
  if (/iphone|ipod/i.test(userAgent)) return true;
  if (/android/i.test(userAgent) && /mobile|mobi/i.test(userAgent)) return true;

  const coarsePointer =
    mediaMatches(win, "(pointer: coarse)") ||
    mediaMatches(win, "(any-pointer: coarse)");
  const width = viewportWidth(win);
  return Number(nav.maxTouchPoints || 0) > 0 && coarsePointer && width <= 900;
}

export function detectMobileRuntimeFromNavigator(win = safeWindow()) {
  return detectPhoneRuntimeFromNavigator(win);
}

export function tabletDesktopRuntimeActive(win = safeWindow()) {
  return !mobileRuntimeForced(win) && detectTabletRuntimeFromNavigator(win);
}

export function mobileShellRuntimeActive(win = safeWindow()) {
  return mobileRuntimeForced(win) || detectPhoneRuntimeFromNavigator(win);
}

export function mobileRuntimeActive(win = safeWindow()) {
  return mobileShellRuntimeActive(win);
}

export const isMobileRuntime = mobileRuntimeActive;
