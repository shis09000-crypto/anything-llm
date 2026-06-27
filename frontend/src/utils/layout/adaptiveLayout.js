export const ADAPTIVE_LAYOUT_MODES = {
  mobile: "mobile",
  tablet: "tablet",
  desktop: "desktop",
};

export const ADAPTIVE_INPUT_MODES = {
  touch: "touch",
  mouse: "mouse",
};

export const ADAPTIVE_SURFACES = {
  browser: "browser",
  pwa: "pwa",
  desktopApp: "desktop-app",
  mobileApp: "mobile-app",
};

export function deriveLayoutMode(viewport = {}) {
  const width = Number(viewport?.width || 0);
  if (width < 768) return ADAPTIVE_LAYOUT_MODES.mobile;
  if (width < 1200) return ADAPTIVE_LAYOUT_MODES.tablet;
  return ADAPTIVE_LAYOUT_MODES.desktop;
}

export function deriveInputMode(input = {}) {
  const pointer = input?.pointer || "none";
  if (pointer === "fine" || input?.hover) return ADAPTIVE_INPUT_MODES.mouse;
  if (input?.touch || pointer === "coarse") return ADAPTIVE_INPUT_MODES.touch;
  return ADAPTIVE_INPUT_MODES.mouse;
}

export function deriveSurface(surface = "browser") {
  switch (surface) {
    case "desktopApp":
    case "desktop-app":
      return ADAPTIVE_SURFACES.desktopApp;
    case "mobileApp":
    case "mobile-app":
      return ADAPTIVE_SURFACES.mobileApp;
    case "pwa":
      return ADAPTIVE_SURFACES.pwa;
    case "browser":
    default:
      return ADAPTIVE_SURFACES.browser;
  }
}

export function deriveAdaptiveLayout(profile = {}) {
  return {
    layoutMode: deriveLayoutMode(profile?.viewport),
    inputMode: deriveInputMode(profile?.input),
    surface: deriveSurface(profile?.surface),
    capabilityProfile: profile,
  };
}

function mediaQueries() {
  return [
    "(hover: hover)",
    "(any-hover: hover)",
    "(pointer: fine)",
    "(pointer: coarse)",
    "(any-pointer: fine)",
    "(any-pointer: coarse)",
    "(display-mode: standalone)",
    "(display-mode: fullscreen)",
  ];
}

export function createAdaptiveLayoutObserver({
  getProfile,
  onChange,
  windowRef = typeof window === "undefined" ? null : window,
} = {}) {
  if (!windowRef || typeof getProfile !== "function") {
    return {
      read: () => deriveAdaptiveLayout(getProfile?.() || {}),
      dispose: () => {},
    };
  }

  let disposed = false;
  let frame = null;
  const mediaLists = mediaQueries()
    .map((query) => {
      try {
        return windowRef.matchMedia?.(query);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const emit = () => {
    if (disposed) return;
    onChange?.(deriveAdaptiveLayout(getProfile()));
  };

  const schedule = () => {
    if (disposed) return;
    if (frame) windowRef.cancelAnimationFrame?.(frame);
    frame = windowRef.requestAnimationFrame
      ? windowRef.requestAnimationFrame(() => {
          frame = null;
          emit();
        })
      : setTimeout(() => {
          frame = null;
          emit();
        }, 0);
  };

  windowRef.addEventListener?.("resize", schedule);
  windowRef.addEventListener?.("orientationchange", schedule);
  mediaLists.forEach((mql) => {
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", schedule);
    } else {
      mql.addListener?.(schedule);
    }
  });

  return {
    read: () => deriveAdaptiveLayout(getProfile()),
    dispose: () => {
      disposed = true;
      if (frame) {
        if (typeof frame === "number" && windowRef.cancelAnimationFrame) {
          windowRef.cancelAnimationFrame(frame);
        } else {
          clearTimeout(frame);
        }
        frame = null;
      }
      windowRef.removeEventListener?.("resize", schedule);
      windowRef.removeEventListener?.("orientationchange", schedule);
      mediaLists.forEach((mql) => {
        if (typeof mql.removeEventListener === "function") {
          mql.removeEventListener("change", schedule);
        } else {
          mql.removeListener?.(schedule);
        }
      });
    },
  };
}
