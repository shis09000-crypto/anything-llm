export const MOBILE_HISTORY_MAX_WIDTH = 768;

function safeNavigator(navigatorLike) {
  if (navigatorLike) return navigatorLike;
  if (typeof globalThis === "undefined") return null;
  return globalThis.navigator || null;
}

function safeWindow(windowLike) {
  if (windowLike) return windowLike;
  if (typeof globalThis === "undefined") return null;
  return globalThis.window || null;
}

export function isNarrowHistoryViewport(windowLike = null) {
  const targetWindow = safeWindow(windowLike);
  if (!targetWindow) return false;

  if (typeof targetWindow.matchMedia === "function") {
    try {
      if (
        targetWindow.matchMedia(`(max-width: ${MOBILE_HISTORY_MAX_WIDTH}px)`)
          .matches
      ) {
        return true;
      }
    } catch {}
  }

  const widths = [
    targetWindow.innerWidth,
    targetWindow.visualViewport?.width,
    targetWindow.document?.documentElement?.clientWidth,
    targetWindow.screen?.width,
  ]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  return widths.some((width) => width <= MOBILE_HISTORY_MAX_WIDTH);
}

export function navigatorReportsMobile(navigatorLike = null) {
  const targetNavigator = safeNavigator(navigatorLike);
  if (!targetNavigator) return false;
  if (targetNavigator.userAgentData?.mobile === true) return true;

  const userAgent = String(targetNavigator.userAgent || "");
  if (
    /Android|iPhone|iPad|iPod|Mobile|Mobi|Windows Phone|webOS|BlackBerry/i.test(
      userAgent
    )
  ) {
    return true;
  }

  return (
    Number(targetNavigator.maxTouchPoints || 0) > 1 &&
    /Macintosh/i.test(userAgent) &&
    isNarrowHistoryViewport()
  );
}

export function historySurfaceForDevice({
  mobile = false,
  windowLike = null,
  navigatorLike = null,
  surface = null,
} = {}) {
  if (surface === "mobile" || surface === "desktop") return surface;
  return mobile ||
    navigatorReportsMobile(navigatorLike) ||
    isNarrowHistoryViewport(windowLike)
    ? "mobile"
    : "desktop";
}

export function historyDetailForDevice(options = {}) {
  return historySurfaceForDevice(options) === "mobile" ? "full" : "light";
}

export function historyPriorityWindowForDevice({
  mobile = false,
  surface = null,
  windowLike = null,
  navigatorLike = null,
  fallback = 10,
} = {}) {
  return historySurfaceForDevice({
    mobile,
    surface,
    windowLike,
    navigatorLike,
  }) === "mobile"
    ? Number.MAX_SAFE_INTEGER
    : fallback;
}

export function historyRequestOptionsForDevice({
  mobile = false,
  surface = null,
  windowLike = null,
  navigatorLike = null,
  limit,
  priorityWindow = 10,
  ...rest
} = {}) {
  const nextLimit = Number(limit || 20);
  const resolvedSurface = historySurfaceForDevice({
    mobile,
    surface,
    windowLike,
    navigatorLike,
  });
  return {
    ...rest,
    limit: nextLimit,
    detail: historyDetailForDevice({ surface: resolvedSurface }),
    priorityWindow: historyPriorityWindowForDevice({
      surface: resolvedSurface,
      fallback: priorityWindow,
    }),
  };
}
