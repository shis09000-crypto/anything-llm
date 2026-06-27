export const ATHENA_CAPABILITY_PROFILE_HEADER = "X-Athena-Capability-Profile";
export const ATHENA_CAPABILITY_SOURCE_HEADER = "X-Athena-Capability-Source";

export const ATHENA_CAPABILITY_PROFILE_QUERY = {
  profile: "athenaCapabilityProfile",
  source: "athenaCapabilitySource",
};

export const CLIENT_SURFACES = {
  browser: "browser",
  pwa: "pwa",
  desktopApp: "desktopApp",
  mobileApp: "mobileApp",
};

function safeWindow() {
  return typeof window === "undefined" ? null : window;
}

function safeNavigator(win = safeWindow()) {
  return (
    win?.navigator || (typeof navigator === "undefined" ? null : navigator)
  );
}

function mediaMatches(win, query) {
  try {
    return !!win?.matchMedia?.(query)?.matches;
  } catch {
    return false;
  }
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundedDimension(value) {
  return Math.max(0, Math.round(finiteNumber(value, 0)));
}

function roundedPixelRatio(value) {
  return Math.max(0, Math.round(finiteNumber(value, 1) * 100) / 100);
}

function detectViewport(win = safeWindow()) {
  return {
    width: roundedDimension(win?.innerWidth),
    height: roundedDimension(win?.innerHeight),
    devicePixelRatio: roundedPixelRatio(win?.devicePixelRatio || 1),
  };
}

function detectInput(win = safeWindow()) {
  const nav = safeNavigator(win);
  const maxTouchPoints = finiteNumber(nav?.maxTouchPoints, 0);
  const coarsePointer =
    mediaMatches(win, "(pointer: coarse)") ||
    mediaMatches(win, "(any-pointer: coarse)");
  const finePointer =
    mediaMatches(win, "(pointer: fine)") ||
    mediaMatches(win, "(any-pointer: fine)");
  const hover =
    mediaMatches(win, "(hover: hover)") ||
    mediaMatches(win, "(any-hover: hover)");

  return {
    touch: maxTouchPoints > 0 || coarsePointer,
    hover,
    pointer: finePointer ? "fine" : coarsePointer ? "coarse" : "none",
  };
}

function detectSurface(win = safeWindow()) {
  const nav = safeNavigator(win);
  const isDesktopApp =
    !!win?.__TAURI__ ||
    !!win?.__ATHENA_DESKTOP__ ||
    !!win?.electron ||
    typeof win?.require === "function";
  if (isDesktopApp) return CLIENT_SURFACES.desktopApp;

  const isMobileApp = !!win?.__ATHENA_MOBILE__ || !!win?.ReactNativeWebView;
  if (isMobileApp) return CLIENT_SURFACES.mobileApp;

  const standalone =
    mediaMatches(win, "(display-mode: standalone)") ||
    mediaMatches(win, "(display-mode: fullscreen)") ||
    nav?.standalone === true;
  if (standalone) return CLIENT_SURFACES.pwa;

  return CLIENT_SURFACES.browser;
}

function detectCapabilities(win = safeWindow()) {
  const nav = safeNavigator(win);
  const mediaDevices = nav?.mediaDevices;
  return {
    camera: !!mediaDevices?.getUserMedia,
    microphone: !!mediaDevices?.getUserMedia,
    filePicker: !!win?.showOpenFilePicker || !!win?.document?.createElement,
    notifications: typeof win?.Notification !== "undefined",
    clipboard: !!nav?.clipboard?.writeText || !!nav?.clipboard?.write,
  };
}

export function getClientCapabilityProfile() {
  const win = safeWindow();
  return {
    viewport: detectViewport(win),
    input: detectInput(win),
    surface: detectSurface(win),
    capabilities: detectCapabilities(win),
  };
}

export function encodeCapabilityProfile(profile = null) {
  if (!profile || typeof profile !== "object") return null;
  const json = JSON.stringify(profile);
  try {
    if (typeof btoa === "function") {
      return btoa(json)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
    }
  } catch {}
  try {
    if (typeof globalThis.Buffer !== "undefined") {
      return globalThis.Buffer.from(json, "utf8").toString("base64url");
    }
  } catch {}
  return encodeURIComponent(json);
}
