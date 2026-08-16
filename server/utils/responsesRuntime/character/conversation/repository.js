const { PLAINTEXT_JSON_STORAGE, encodeStored } = require("../../repository");
const { sha256 } = require("../../contract");

function decodePlainJson(value) {
  let payload = null;
  try {
    payload = JSON.parse(String(value ?? ""));
  } catch {
    const error = new Error("character_conversation_json_invalid");
    error.code = "character_conversation_json_invalid";
    throw error;
  }
  if (payload?.format === "athena.responses.ciphertext.v1") {
    const error = new Error(
      "character_conversation_legacy_session_unsupported"
    );
    error.code = "character_conversation_legacy_session_unsupported";
    throw error;
  }
  return payload;
}

class CharacterConversationRepository {
  constructor({ client, env = process.env } = {}) {
    this.client = client;
    this.env = env;
  }

  async createConversation(data, sessionState) {
    const stateJson = await encodeStored(
      sessionState,
      `${data.id}:character-state:0`,
      PLAINTEXT_JSON_STORAGE,
      this.env
    );
    return this.client.responses_conversations.create({
      data: {
        ...data,
        conversationType: "character",
        stateRevision: 0,
        stateJson,
        stateHash: sha256(sessionState),
      },
    });
  }

  findConversation(id) {
    return this.client.responses_conversations.findUnique({ where: { id } });
  }

  async readSessionState(row) {
    if (!row?.stateJson) return null;
    return decodePlainJson(row.stateJson);
  }

  async updateSessionState(
    row,
    sessionState,
    { status, currentTurnId = null, softCloseDueAt = null, endedAt = null } = {}
  ) {
    const nextRevision = sessionState.character_state.revision;
    const stateJson = await encodeStored(
      sessionState,
      `${row.id}:character-state:${nextRevision}`,
      PLAINTEXT_JSON_STORAGE,
      this.env
    );
    const updated = await this.client.responses_conversations.updateMany({
      where: { id: row.id, stateRevision: row.stateRevision },
      data: {
        stateRevision: nextRevision,
        stateJson,
        stateHash: sha256(sessionState),
        status,
        currentTurnId,
        softCloseDueAt,
        ...(endedAt ? { endedAt } : {}),
      },
    });
    return updated.count === 1;
  }

  updateConversation(id, data) {
    return this.client.responses_conversations.update({ where: { id }, data });
  }

  async claimTurn(conversation, turnId) {
    const claimed = await this.client.responses_conversations.updateMany({
      where: {
        id: conversation.id,
        currentTurnId: null,
        status: {
          in: ["created", "awaiting_user", "close_ready", "soft_closed"],
        },
      },
      data: {
        status: conversation.status === "soft_closed" ? "resuming" : "active",
        currentTurnId: turnId,
        softCloseDueAt: null,
        suspensionReason: null,
        suspendedAt: null,
      },
    });
    return claimed.count === 1;
  }

  findTurnByIdempotencyKey(idempotencyKey) {
    return this.client.character_conversation_turns.findUnique({
      where: { idempotencyKey },
    });
  }

  async nextOrdinal(conversationId) {
    const last = await this.client.character_conversation_turns.findFirst({
      where: { conversationId },
      orderBy: { ordinal: "desc" },
      select: { ordinal: true },
    });
    return Number(last?.ordinal || 0) + 1;
  }

  async createTurn(data, input) {
    const inputJson = await encodeStored(
      input,
      `${data.id}:turn-input`,
      PLAINTEXT_JSON_STORAGE,
      this.env
    );
    return this.client.character_conversation_turns.create({
      data: { ...data, inputJson, inputHash: sha256(input) },
    });
  }

  async completeTurn(id, data, control) {
    const controlJson = await encodeStored(
      control,
      `${id}:turn-control`,
      PLAINTEXT_JSON_STORAGE,
      this.env
    );
    return this.client.character_conversation_turns.update({
      where: { id },
      data: {
        ...data,
        memoryStatus: data.memoryStatus || "committed",
        memoryCommittedAt: data.memoryStatus === "pending" ? null : new Date(),
        memoryErrorCode: data.memoryErrorCode || null,
        controlJson,
        controlHash: sha256(control),
        completedAt: new Date(),
      },
    });
  }

  async markMemoryPending(id, data, control, errorCode) {
    const controlJson = await encodeStored(
      control,
      `${id}:turn-control`,
      PLAINTEXT_JSON_STORAGE,
      this.env
    );
    return this.client.character_conversation_turns.update({
      where: { id },
      data: {
        ...data,
        status: "memory_pending",
        memoryStatus: "pending",
        memoryCommitAttempts: { increment: 1 },
        memoryErrorCode: String(
          errorCode || "athena_3d_memory_commit_failed"
        ).slice(0, 160),
        controlJson,
        controlHash: sha256(control),
      },
    });
  }

  markMemoryCommitted(id, memoryCommit = null) {
    return this.client.character_conversation_turns.update({
      where: { id },
      data: {
        status: "completed",
        memoryStatus: "committed",
        memoryCommitAttempts: { increment: 1 },
        memoryErrorCode: null,
        memoryCommittedAt: new Date(),
        ...(memoryCommit?.context_ref
          ? { contextJson: JSON.stringify(memoryCommit.context_ref) }
          : {}),
        completedAt: new Date(),
      },
    });
  }

  pendingMemoryTurn(conversationId) {
    return this.client.character_conversation_turns.findFirst({
      where: {
        conversationId,
        status: "memory_pending",
        memoryStatus: "pending",
      },
      orderBy: { ordinal: "asc" },
    });
  }

  pendingMemoryTurns(limit = 25) {
    return this.client.character_conversation_turns.findMany({
      where: { status: "memory_pending", memoryStatus: "pending" },
      orderBy: { lastUpdatedAt: "asc" },
      take: Math.max(1, Math.min(Number(limit) || 25, 100)),
    });
  }

  failTurn(id, endReason) {
    return this.client.character_conversation_turns.update({
      where: { id },
      data: { status: "failed", endReason, completedAt: new Date() },
    });
  }

  async hydrateTurn(row) {
    if (!row) return null;
    const input = decodePlainJson(row.inputJson);
    const control = row.controlJson ? decodePlainJson(row.controlJson) : null;
    let previousContextRef = null;
    let contextRef = null;
    try {
      previousContextRef = row.previousContextJson
        ? JSON.parse(row.previousContextJson)
        : null;
      contextRef = row.contextJson ? JSON.parse(row.contextJson) : null;
    } catch {}
    return { ...row, input, control, previousContextRef, contextRef };
  }

  async recentTurns(conversationId, limit = 12) {
    const rows = await this.client.character_conversation_turns.findMany({
      where: { conversationId, status: "completed" },
      orderBy: { ordinal: "desc" },
      take: limit,
    });
    return Promise.all(rows.reverse().map((row) => this.hydrateTurn(row)));
  }

  async appendEvent({
    conversationId,
    eventType,
    turnId = null,
    responseId = null,
    payload,
  }) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const last = await this.client.character_conversation_events.findFirst({
        where: { conversationId },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });
      const sequence = Number(last?.sequence ?? -1) + 1;
      const envelope = {
        type: eventType,
        event_id: `chr_conv_evt_${conversationId}_${sequence}`,
        sequence_number: sequence,
        created_at: Date.now(),
        conversation_id: conversationId,
        ...(turnId ? { turn_id: turnId } : {}),
        ...(responseId ? { response_id: responseId } : {}),
        ...payload,
      };
      const resource = `${conversationId}:conversation-event:${sequence}`;
      try {
        await this.client.character_conversation_events.create({
          data: {
            conversationId,
            sequence,
            eventType,
            turnId,
            responseId,
            payloadJson: await encodeStored(
              envelope,
              resource,
              PLAINTEXT_JSON_STORAGE,
              this.env
            ),
            payloadHash: sha256(envelope),
          },
        });
        return envelope;
      } catch (error) {
        if (error?.code !== "P2002" || attempt === 3) throw error;
      }
    }
    return null;
  }

  async listEvents(conversationId, after = -1) {
    const rows = await this.client.character_conversation_events.findMany({
      where: { conversationId, sequence: { gt: Number(after) } },
      orderBy: { sequence: "asc" },
    });
    return Promise.all(rows.map((row) => decodePlainJson(row.payloadJson)));
  }

  dueSoftCloses(now = new Date(), limit = 25) {
    return this.client.responses_conversations.findMany({
      where: {
        conversationType: "character",
        status: "close_ready",
        softCloseDueAt: { lte: now },
      },
      orderBy: { softCloseDueAt: "asc" },
      take: Math.max(1, Math.min(Number(limit) || 25, 100)),
    });
  }
}

module.exports = { CharacterConversationRepository };
