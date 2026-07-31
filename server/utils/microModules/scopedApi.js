function normalizePath(value) {
  const path = String(value || "/").split("?")[0] || "/";
  return path.startsWith("/") ? path : `/${path}`;
}

function createApiScope({ exact = [], prefixes = [], patterns = [] } = {}) {
  const exactPaths = new Set(exact.map(normalizePath));
  const normalizedPrefixes = prefixes.map(normalizePath);
  const normalizedPatterns = patterns.filter(
    (pattern) => pattern instanceof RegExp
  );

  return function scopedApi(request, response, next) {
    const path = normalizePath(request.path || request.url);
    const allowed =
      exactPaths.has(path) ||
      normalizedPrefixes.some(
        (prefix) => path === prefix || path.startsWith(`${prefix}/`)
      ) ||
      normalizedPatterns.some((pattern) => pattern.test(path));
    if (allowed) return next();
    return response.status(404).json({
      success: false,
      error: "module_route_not_owned",
    });
  };
}

module.exports = { createApiScope, normalizePath };
