const DEFAULT_MAX_TURNS = 64;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function scopeKey({ workspaceId, threadId = null, userId = null } = {}) {
  return [
    Number(workspaceId),
    threadId === null ? "workspace" : Number(threadId),
    userId === null ? "anonymous" : Number(userId),
  ].join(":");
}

function entryBytes(entry = {}) {
  return (
    Buffer.byteLength(String(entry.prompt || ""), "utf8") +
    Buffer.byteLength(String(entry.response || ""), "utf8")
  );
}

class HotTurnBuffer {
  constructor({ maxTurns, maxBytes, ttlMs } = {}) {
    this.maxTurns = positiveInteger(
      maxTurns ?? process.env.ATHENA_HOT_TURN_MAX_TURNS,
      DEFAULT_MAX_TURNS
    );
    this.maxBytes = positiveInteger(
      maxBytes ?? process.env.ATHENA_HOT_TURN_MAX_BYTES,
      DEFAULT_MAX_BYTES
    );
    this.ttlMs = positiveInteger(
      ttlMs ?? process.env.ATHENA_HOT_TURN_TTL_MS,
      DEFAULT_TTL_MS
    );
    this.entries = new Map();
    this.scopeIndex = new Map();
    this.totalBytes = 0;
  }

  cleanupExpired(now = Date.now()) {
    for (const [clientTurnId, entry] of this.entries.entries()) {
      if (now - entry.createdAt >= this.ttlMs) this.delete(clientTurnId);
    }
  }

  stage(input = {}) {
    this.cleanupExpired();
    const clientTurnId = String(input.clientTurnId || "").trim();
    if (!clientTurnId)
      return { accepted: false, reason: "client_turn_required" };
    if (this.entries.has(clientTurnId)) {
      return { accepted: true, entry: this.entries.get(clientTurnId) };
    }

    const bytes = entryBytes(input);
    if (
      this.entries.size >= this.maxTurns ||
      bytes > this.maxBytes ||
      this.totalBytes + bytes > this.maxBytes
    ) {
      return { accepted: false, reason: "capacity" };
    }

    const key = scopeKey(input);
    const entry = {
      clientTurnId,
      workspaceId: Number(input.workspaceId),
      threadId: input.threadId === null ? null : Number(input.threadId),
      userId: input.userId === null ? null : Number(input.userId),
      prompt: String(input.prompt || ""),
      response: String(input.response || ""),
      bytes,
      createdAt: Date.now(),
      status: "pending",
      metadata: input.metadata || null,
      expiryTimer: null,
    };
    entry.expiryTimer = setTimeout(() => this.delete(clientTurnId), this.ttlMs);
    entry.expiryTimer.unref?.();
    this.entries.set(clientTurnId, entry);
    const turns = this.scopeIndex.get(key) || [];
    turns.push(clientTurnId);
    this.scopeIndex.set(key, turns);
    this.totalBytes += bytes;
    return { accepted: true, entry };
  }

  updateStatus(clientTurnId, status) {
    const entry = this.entries.get(String(clientTurnId || "").trim());
    if (!entry) return false;
    entry.status = status;
    return true;
  }

  pendingForScope(scope = {}, { persistedClientTurnIds = [] } = {}) {
    this.cleanupExpired();
    const persisted = new Set(
      persistedClientTurnIds.map((value) => String(value || "").trim())
    );
    const ids = this.scopeIndex.get(scopeKey(scope)) || [];
    return ids
      .map((id) => this.entries.get(id))
      .filter(Boolean)
      .filter((entry) => !persisted.has(entry.clientTurnId))
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((entry) => ({ ...entry }));
  }

  delete(clientTurnId) {
    const id = String(clientTurnId || "").trim();
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    const key = scopeKey(entry);
    const next = (this.scopeIndex.get(key) || []).filter(
      (candidate) => candidate !== id
    );
    if (next.length) this.scopeIndex.set(key, next);
    else this.scopeIndex.delete(key);
    this.totalBytes = Math.max(0, this.totalBytes - entry.bytes);
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    entry.expiryTimer = null;
    entry.prompt = "";
    entry.response = "";
    entry.metadata = null;
    return true;
  }

  deleteScope(scope = {}) {
    for (const id of [...(this.scopeIndex.get(scopeKey(scope)) || [])])
      this.delete(id);
  }

  snapshot() {
    this.cleanupExpired();
    return {
      turns: this.entries.size,
      bytes: this.totalBytes,
      maxTurns: this.maxTurns,
      maxBytes: this.maxBytes,
    };
  }
}

class FinalizedTurnPersister {
  constructor() {
    this.chains = new Map();
  }

  enqueue(key, operation) {
    const normalizedKey = String(key || "global");
    const previous = this.chains.get(normalizedKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.chains.set(normalizedKey, current);
    current.finally(() => {
      if (this.chains.get(normalizedKey) === current)
        this.chains.delete(normalizedKey);
    });
    return current;
  }

  async drain() {
    await Promise.allSettled([...this.chains.values()]);
  }

  snapshot() {
    return { pendingPersistenceQueues: this.chains.size };
  }
}

const hotTurnBuffer = new HotTurnBuffer();
const finalizedTurnPersister = new FinalizedTurnPersister();

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_TURNS,
  DEFAULT_TTL_MS,
  FinalizedTurnPersister,
  HotTurnBuffer,
  entryBytes,
  finalizedTurnPersister,
  hotTurnBuffer,
  scopeKey,
};
