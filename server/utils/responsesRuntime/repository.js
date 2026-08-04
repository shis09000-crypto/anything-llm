const prisma = require("../prisma");
const zlib = require("zlib");
const {
  wrapMaterial,
  unwrapMaterial,
} = require("../security/keyCustody/remoteClient");
const { canonicalJson, sha256, stateItemFingerprint } = require("./contract");

const CHUNK_BYTES = 36 * 1024;
const CIPHERTEXT_V1 = "athena.responses.ciphertext.v1";
const CIPHERTEXT_V2 = "athena.responses.ciphertext.v2";
const EVENT_BATCH_V1 = "athena.response.event-batch.v1";
const COMPRESS_THRESHOLD_BYTES = 4 * 1024;
const custodyGate = {
  active: 0,
  queue: [],
};

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await mapper(items[index], index);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

function drainCustodyGate() {
  while (custodyGate.queue.length) {
    const next = custodyGate.queue[0];
    if (custodyGate.active >= next.limit) return;
    custodyGate.queue.shift();
    custodyGate.active += 1;
    next.resolve();
  }
}

async function withCustodySlot(task, limit) {
  await new Promise((resolve) => {
    custodyGate.queue.push({ resolve, limit: Math.min(4, limit) });
    drainCustodyGate();
  });
  try {
    return await task();
  } finally {
    custodyGate.active -= 1;
    drainCustodyGate();
  }
}

class CheckpointLru {
  constructor({ maxEntries = 64, maxBytes = 64 * 1024 * 1024 } = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.entries = new Map();
    this.bytes = 0;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value, bytes) {
    this.delete(key);
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    while (
      this.entries.size > this.maxEntries ||
      (this.bytes > this.maxBytes && this.entries.size > 1)
    ) {
      const oldest = this.entries.keys().next().value;
      this.delete(oldest);
    }
  }

  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}

function custodyContext(resource, operation) {
  return {
    purpose: "responses-state",
    domain: "responses-runtime",
    resource: String(resource),
    operation,
  };
}

async function protect(value, resource, env = process.env) {
  const plaintext = Buffer.from(canonicalJson(value), "utf8");
  const shouldCompress = plaintext.length > COMPRESS_THRESHOLD_BYTES;
  const encoded = shouldCompress
    ? zlib.gzipSync(plaintext, { level: zlib.constants.Z_BEST_SPEED })
    : plaintext;
  const rawChunks = [];
  for (let offset = 0; offset < encoded.length; offset += CHUNK_BYTES)
    rawChunks.push(encoded.subarray(offset, offset + CHUNK_BYTES));
  const concurrency = Math.min(
    4,
    positiveInteger(env.ATHENA_RESPONSES_KEY_CUSTODY_CONCURRENCY, 4)
  );
  const chunks = await mapConcurrent(
    rawChunks,
    concurrency,
    async (chunk, index) =>
      withCustodySlot(
        () =>
          wrapMaterial(
            chunk.toString("base64"),
            custodyContext(`${resource}:${index}`, "wrap"),
            env
          ),
        concurrency
      )
  );
  return JSON.stringify({
    format: CIPHERTEXT_V2,
    encoding: shouldCompress ? "gzip" : "identity",
    chunks,
  });
}

async function unprotect(ciphertext, resource, env = process.env) {
  let envelope;
  try {
    envelope = JSON.parse(String(ciphertext || ""));
  } catch {
    envelope = null;
  }
  if (
    ![CIPHERTEXT_V1, CIPHERTEXT_V2].includes(envelope?.format) ||
    !Array.isArray(envelope.chunks) ||
    envelope.chunks.length === 0 ||
    (envelope.format === CIPHERTEXT_V2 &&
      !["identity", "gzip"].includes(envelope.encoding))
  ) {
    const error = new Error("response_state_ciphertext_invalid");
    error.code = "response_state_ciphertext_invalid";
    throw error;
  }
  const concurrency = Math.min(
    4,
    positiveInteger(env.ATHENA_RESPONSES_KEY_CUSTODY_CONCURRENCY, 4)
  );
  const buffers = await mapConcurrent(
    envelope.chunks,
    concurrency,
    async (chunk, index) => {
      const value = await withCustodySlot(
        () =>
          unwrapMaterial(
            chunk,
            custodyContext(`${resource}:${index}`, "unwrap"),
            env
          ),
        concurrency
      );
      return Buffer.from(value, "base64");
    }
  );
  const encoded = Buffer.concat(buffers);
  const plaintext =
    envelope.format === CIPHERTEXT_V2 && envelope.encoding === "gzip"
      ? zlib.gunzipSync(encoded)
      : encoded;
  return JSON.parse(plaintext.toString("utf8"));
}

class ResponsesRepository {
  constructor({ client = prisma, env = process.env } = {}) {
    this.client = client;
    this.env = env;
    this.checkpoints = new CheckpointLru({
      maxEntries: positiveInteger(
        env.ATHENA_RESPONSES_CHECKPOINT_CACHE_ENTRIES,
        64
      ),
      maxBytes:
        positiveInteger(env.ATHENA_RESPONSES_CHECKPOINT_CACHE_MIB, 64) *
        1024 *
        1024,
    });
    this.custodyWrapCalls = 0;
    this.custodyUnwrapCalls = 0;
  }

  observeCiphertext(ciphertext, operation) {
    try {
      const chunks = JSON.parse(String(ciphertext || "")).chunks?.length || 0;
      if (operation === "wrap") this.custodyWrapCalls += chunks;
      if (operation === "unwrap") this.custodyUnwrapCalls += chunks;
    } catch {
      // Cipher validation remains the responsibility of unprotect().
    }
  }

  snapshot() {
    return {
      keyCustodyWrapCalls: this.custodyWrapCalls,
      keyCustodyUnwrapCalls: this.custodyUnwrapCalls,
      checkpointCacheEntries: this.checkpoints.entries.size,
      checkpointCacheBytes: this.checkpoints.bytes,
    };
  }

  async findConversation(id) {
    return this.client.responses_conversations.findUnique({ where: { id } });
  }

  async findConversationByScope(scopeKey) {
    return this.client.responses_conversations.findUnique({
      where: { scopeKey },
    });
  }

  async createConversation(data) {
    return this.client.responses_conversations.create({ data });
  }

  async ensureConversation({
    id,
    scopeKey,
    workspaceId,
    threadId,
    agentRunId,
    ownerUserId,
  }) {
    const byScope = await this.findConversationByScope(scopeKey);
    if (byScope) return byScope;
    try {
      return await this.createConversation({
        id,
        scopeKey,
        workspaceId,
        threadId,
        agentRunId,
        ownerUserId,
      });
    } catch (error) {
      if (error?.code !== "P2002") throw error;
      return this.findConversationByScope(scopeKey);
    }
  }

  async advanceConversationHead(id, responseId) {
    const candidate = await this.findResponse(responseId);
    if (!candidate) return false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const conversation = await this.findConversation(id);
      if (!conversation || conversation.deletedAt) return false;
      const current = conversation.currentHeadResponseId
        ? await this.findResponse(conversation.currentHeadResponseId)
        : null;
      if (current && current.createdAt > candidate.createdAt) return false;
      const updated = await this.client.responses_conversations.updateMany({
        where: {
          id,
          currentHeadResponseId: conversation.currentHeadResponseId,
        },
        data: { currentHeadResponseId: responseId, lastUpdatedAt: new Date() },
      });
      if (updated.count === 1) return true;
    }
    return false;
  }

  async createResponse(data) {
    return this.client.responses.create({ data });
  }

  async findResponse(id) {
    return this.client.responses.findUnique({ where: { id } });
  }

  async findResponseByIdempotencyKey(idempotencyKey) {
    if (!idempotencyKey) return null;
    return this.client.responses.findUnique({ where: { idempotencyKey } });
  }

  async findLatestResponseByAgentRunId(agentRunId) {
    if (!agentRunId) return null;
    return this.client.responses.findFirst({
      where: { agentRunId: String(agentRunId) },
      orderBy: { createdAt: "desc" },
    });
  }

  async updateResponse(id, data) {
    return this.client.responses.update({ where: { id }, data });
  }

  async findNearestInputAncestor(conversationId, input = []) {
    const candidates = await this.client.responses.findMany({
      where: {
        conversationId,
        store: true,
        status: { in: ["completed", "incomplete"] },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    for (const candidate of candidates) {
      const checkpoint = await this.readCheckpoint(candidate.id);
      const candidateInput = checkpoint?.state?.input;
      if (
        !Array.isArray(candidateInput) ||
        candidateInput.length > input.length
      )
        continue;
      const identical = candidateInput.every(
        (item, index) =>
          stateItemFingerprint(item) === stateItemFingerprint(input[index])
      );
      if (identical) return { responseId: candidate.id, input: candidateInput };
    }
    return null;
  }

  async claimQueued({ ownerId, leaseMs = 30_000 } = {}) {
    const now = new Date();
    const candidate = await this.client.responses.findFirst({
      where: {
        status: "queued",
        background: true,
        cancelRequestedAt: null,
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      orderBy: { createdAt: "asc" },
    });
    if (!candidate) return null;
    const claimed = await this.client.responses.updateMany({
      where: {
        id: candidate.id,
        status: "queued",
        cancelRequestedAt: null,
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      data: {
        leaseOwner: String(ownerId),
        leaseExpiresAt: new Date(now.getTime() + Math.max(5_000, leaseMs)),
      },
    });
    return claimed.count === 1 ? this.findResponse(candidate.id) : null;
  }

  async requestCancel(id) {
    return this.client.responses.update({
      where: { id },
      data: { cancelRequestedAt: new Date() },
    });
  }

  async appendItem({
    responseId,
    sequence,
    itemType,
    role = null,
    callId = null,
    status = null,
    payload,
  }) {
    const id = `${responseId}:item:${sequence}`;
    const payloadHash = sha256(payload);
    const payloadCiphertext = await protect(payload, id, this.env);
    this.observeCiphertext(payloadCiphertext, "wrap");
    return this.client.response_items.create({
      data: {
        id,
        responseId,
        sequence,
        itemType,
        role,
        callId,
        status,
        payloadCiphertext,
        payloadHash,
      },
    });
  }

  async appendEvent({ responseId, sequence, eventType, payload }) {
    const resource = `${responseId}:event:${sequence}`;
    const payloadHash = sha256(payload);
    const payloadCiphertext = await protect(payload, resource, this.env);
    this.observeCiphertext(payloadCiphertext, "wrap");
    return this.client.response_events.create({
      data: {
        responseId,
        sequence,
        eventType,
        payloadCiphertext,
        payloadHash,
      },
    });
  }

  async appendEventBatch({ responseId, events }) {
    if (!Array.isArray(events) || events.length === 0) return null;
    const normalized = events
      .map((event) => event?.payload || event)
      .filter((event) => Number.isFinite(Number(event?.sequence_number)))
      .sort((left, right) => left.sequence_number - right.sequence_number);
    if (!normalized.length) return null;
    const sequenceStart = normalized[0].sequence_number;
    const sequenceEnd = normalized.at(-1).sequence_number;
    return this.appendEvent({
      responseId,
      sequence: sequenceEnd,
      eventType: EVENT_BATCH_V1,
      payload: {
        schema: EVENT_BATCH_V1,
        sequenceStart,
        sequenceEnd,
        events: normalized,
      },
    });
  }

  async listEvents(responseId, after = -1) {
    const rows = await this.client.response_events.findMany({
      where: { responseId, sequence: { gt: Number(after) } },
      orderBy: { sequence: "asc" },
    });
    const decrypted = await Promise.all(
      rows.map(async (row) => ({
        ...row,
        payload: await unprotect(
          row.payloadCiphertext,
          `${responseId}:event:${row.sequence}`,
          this.env
        ).finally(() =>
          this.observeCiphertext(row.payloadCiphertext, "unwrap")
        ),
      }))
    );
    const events = [];
    for (const row of decrypted) {
      if (
        row.eventType === EVENT_BATCH_V1 &&
        row.payload?.schema === EVENT_BATCH_V1 &&
        Array.isArray(row.payload.events)
      ) {
        for (const payload of row.payload.events) {
          const sequence = Number(payload?.sequence_number);
          if (Number.isFinite(sequence) && sequence > Number(after))
            events.push({ ...row, sequence, eventType: payload.type, payload });
        }
        continue;
      }
      events.push(row);
    }
    return events.sort((left, right) => left.sequence - right.sequence);
  }

  async listItems(responseId) {
    const rows = await this.client.response_items.findMany({
      where: { responseId },
      orderBy: { sequence: "asc" },
    });
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        payload: await unprotect(
          row.payloadCiphertext,
          `${responseId}:item:${row.sequence}`,
          this.env
        ).finally(() =>
          this.observeCiphertext(row.payloadCiphertext, "unwrap")
        ),
      }))
    );
  }

  async writeCheckpoint(responseId, state) {
    const resource = `${responseId}:checkpoint`;
    const stateCiphertext = await protect(state, resource, this.env);
    this.observeCiphertext(stateCiphertext, "wrap");
    const stateHash = sha256(state);
    const row = await this.client.response_checkpoints.upsert({
      where: { responseId },
      create: { responseId, stateCiphertext, stateHash },
      update: { stateCiphertext, stateHash, lastUpdatedAt: new Date() },
    });
    this.checkpoints.set(
      responseId,
      { ...row, state },
      Buffer.byteLength(canonicalJson(state), "utf8")
    );
    return row;
  }

  async readCheckpoint(responseId) {
    if (!responseId) return null;
    const cached = this.checkpoints.get(responseId);
    if (cached) return cached;
    const row = await this.client.response_checkpoints.findUnique({
      where: { responseId },
    });
    if (!row) return null;
    const state = await unprotect(
      row.stateCiphertext,
      `${responseId}:checkpoint`,
      this.env
    ).finally(() => this.observeCiphertext(row.stateCiphertext, "unwrap"));
    const hydrated = {
      ...row,
      state,
    };
    this.checkpoints.set(
      responseId,
      hydrated,
      Buffer.byteLength(canonicalJson(hydrated.state), "utf8")
    );
    return hydrated;
  }

  clearCheckpointCache() {
    this.checkpoints.clear();
  }

  async deleteResponse(id) {
    const response = await this.findResponse(id);
    if (!response) return null;
    if (response.conversationId)
      await this.client.responses_conversations.updateMany({
        where: { id: response.conversationId, currentHeadResponseId: id },
        data: { currentHeadResponseId: response.previousResponseId },
      });
    await this.client.$transaction([
      this.client.response_events.deleteMany({ where: { responseId: id } }),
      this.client.response_items.deleteMany({ where: { responseId: id } }),
      this.client.response_checkpoints.deleteMany({
        where: { responseId: id },
      }),
      this.client.responses.delete({ where: { id } }),
    ]);
    this.checkpoints.delete(id);
    return response;
  }

  async deleteConversation(id) {
    const responses = await this.client.responses.findMany({
      where: { conversationId: id },
      select: { id: true },
    });
    for (const response of responses) await this.deleteResponse(response.id);
    await this.client.response_compactions.deleteMany({
      where: { conversationId: id },
    });
    return this.client.responses_conversations.delete({ where: { id } });
  }

  async createCompaction({
    id,
    conversationId,
    throughResponseId,
    sourceCapsuleId = null,
    payload,
  }) {
    const payloadCiphertext = await protect(
      payload,
      `${id}:compaction`,
      this.env
    );
    this.observeCiphertext(payloadCiphertext, "wrap");
    return this.client.response_compactions.create({
      data: {
        id,
        conversationId,
        throughResponseId,
        sourceCapsuleId,
        payloadCiphertext,
        payloadHash: sha256(payload),
      },
    });
  }

  async expiredConversationIds({ now = new Date(), limit = 25 } = {}) {
    const rows = await this.client.responses.findMany({
      where: {
        store: true,
        expiresAt: { lte: now },
        contentPrunedAt: null,
        conversationId: { not: null },
      },
      orderBy: { expiresAt: "asc" },
      take: Math.max(1, Math.min(Number(limit) || 25, 100)),
      select: { conversationId: true },
    });
    return [...new Set(rows.map((row) => row.conversationId).filter(Boolean))];
  }

  async latestCompaction(conversationId) {
    return this.client.response_compactions.findFirst({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
    });
  }

  async pruneExpiredConversation(conversationId, { now = new Date() } = {}) {
    const conversation = await this.findConversation(conversationId);
    const compaction = await this.latestCompaction(conversationId);
    if (!conversation || !compaction) return { pruned: 0 };
    const through = await this.findResponse(compaction.throughResponseId);
    if (!through || through.conversationId !== conversationId)
      return { pruned: 0 };
    const rows = await this.client.responses.findMany({
      where: {
        conversationId,
        store: true,
        expiresAt: { lte: now },
        contentPrunedAt: null,
        id: { not: conversation.currentHeadResponseId || "" },
        createdAt: { lte: through.createdAt },
      },
      select: { id: true },
    });
    if (!rows.length) return { pruned: 0 };
    const ids = rows.map((row) => row.id);
    await this.client.$transaction([
      this.client.response_events.deleteMany({
        where: { responseId: { in: ids } },
      }),
      this.client.response_items.deleteMany({
        where: { responseId: { in: ids } },
      }),
      this.client.response_checkpoints.deleteMany({
        where: { responseId: { in: ids } },
      }),
      this.client.responses.updateMany({
        where: { id: { in: ids }, contentPrunedAt: null },
        data: { contentPrunedAt: now },
      }),
    ]);
    for (const id of ids) this.checkpoints.delete(id);
    return { pruned: ids.length, responseIds: ids };
  }
}

module.exports = {
  CHUNK_BYTES,
  CIPHERTEXT_V1,
  CIPHERTEXT_V2,
  EVENT_BATCH_V1,
  CheckpointLru,
  ResponsesRepository,
  mapConcurrent,
  protect,
  unprotect,
};
