class CryptoHubRateLimitState {
  constructor() {
    this.publicRest = null;
    this.privateRest = null;
  }

  update(scope, rateLimit) {
    if (!rateLimit) return;
    const key = scope === "public" ? "publicRest" : "privateRest";
    this[key] = {
      updatedAt: Date.now(),
      rateLimit,
      remainPct:
        rateLimit.remainPct === undefined ? null : Number(rateLimit.remainPct),
    };
  }

  snapshot() {
    return {
      publicRest: this.publicRest,
      privateRest: this.privateRest,
    };
  }
}

module.exports = {
  CryptoHubRateLimitState,
};
