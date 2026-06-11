function exponentialRetryDelay({
  attempt = 0,
  baseMs = 1_000,
  maxMs = 30_000,
} = {}) {
  return Math.min(baseMs * 2 ** Math.min(Number(attempt) || 0, 6), maxMs);
}

module.exports = {
  exponentialRetryDelay,
};
