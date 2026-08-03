const prisma = require("../prisma");
const {
  wrapMaterial,
  unwrapMaterial,
} = require("../security/keyCustody/remoteClient");
const { canonicalJson, sha256 } = require("./contract");

const CHUNK_BYTES = 36 * 1024;

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
  const chunks = [];
  for (let offset = 0; offset < plaintext.length; offset += CHUNK_BYTES) {
    const chunk = plaintext.subarray(offset, offset + CHUNK_BYTES);
    chunks.push(
      await wrapMaterial(
        chunk.toString("base64"),
        custodyContext(`${resource}:${chunks.length}`, "wrap"),
        env
      )
    );
  }
  return JSON.stringify({ format: "athena.responses.ciphertext.v1", chunks });
}

async function unprotect(ciphertext, resource, env = process.env) {
  let envelope;
  try {
    envelope = JSON.parse(String(ciphertext || ""));
  } catch {
    envelope = null;
  }
  if (
    envelope?.format !== "athena.responses.ciphertext.v1" ||
    !Array.isArray(envelope.chunks) ||
    envelope.chunks.length === 0
  ) {
    const error = new Error("response_state_ciphertext_invalid");
    error.code = "response_state_ciphertext_invalid";
    throw error;
  }
  const buffers = [];
  for (let index = 0; index < envelope.chunks.length; index += 1) {
    const value = await unwrapMaterial(
      envelope.chunks[index],
      custodyContext(`${resource}:${index}`, "unwrap"),
      env
    );
    buffers.push(Buffer.from(value, "base64"));
  }
  return JSON.parse(Buffer.concat(buffers).toString("utf8"));
}

class ResponsesRepository {
  constructor({ client = prisma, env = process.env } = {}) {
    this.client = client;
    this.env = env;
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
        (item, index) => sha256(item) === sha256(input[index])
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

  async listEvents(responseId, after = -1) {
    const rows = await this.client.response_events.findMany({
      where: { responseId, sequence: { gt: Number(after) } },
      orderBy: { sequence: "asc" },
    });
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        payload: await unprotect(
          row.payloadCiphertext,
          `${responseId}:event:${row.sequence}`,
          this.env
        ),
      }))
    );
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
        ),
      }))
    );
  }

  async writeCheckpoint(responseId, state) {
    const resource = `${responseId}:checkpoint`;
    const stateCiphertext = await protect(state, resource, this.env);
    const stateHash = sha256(state);
    return this.client.response_checkpoints.upsert({
      where: { responseId },
      create: { responseId, stateCiphertext, stateHash },
      update: { stateCiphertext, stateHash, lastUpdatedAt: new Date() },
    });
  }

  async readCheckpoint(responseId) {
    if (!responseId) return null;
    const row = await this.client.response_checkpoints.findUnique({
      where: { responseId },
    });
    if (!row) return null;
    return {
      ...row,
      state: await unprotect(
        row.stateCiphertext,
        `${responseId}:checkpoint`,
        this.env
      ),
    };
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
    return { pruned: ids.length, responseIds: ids };
  }
}

module.exports = {
  CHUNK_BYTES,
  ResponsesRepository,
  protect,
  unprotect,
};
