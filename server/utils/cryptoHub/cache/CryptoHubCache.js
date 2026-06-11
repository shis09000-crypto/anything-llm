class CryptoHubCache {
  constructor() {
    this.store = new Map();
  }

  set(key, value, { ttlMs = null } = {}) {
    this.store.set(key, {
      value,
      updatedAt: Date.now(),
      expiresAt: ttlMs ? Date.now() + ttlMs : null,
    });
    return value;
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  freshness(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    return {
      updatedAt: entry.updatedAt,
      ageMs: Date.now() - entry.updatedAt,
      expiresAt: entry.expiresAt,
    };
  }

  clear(key = null) {
    if (key) this.store.delete(key);
    else this.store.clear();
  }
}

module.exports = {
  CryptoHubCache,
};
