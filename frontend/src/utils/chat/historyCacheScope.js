export function normalizeHistoryCacheDetail(detail = "light") {
  return detail === "full" ? "full" : "light";
}

export function normalizeHistoryCacheSurface(surface = "desktop") {
  return surface === "mobile" ? "mobile" : "desktop";
}

export function historyCacheScope({
  detail = "light",
  surface = "desktop",
} = {}) {
  return {
    detail: normalizeHistoryCacheDetail(detail),
    surface: normalizeHistoryCacheSurface(surface),
  };
}
