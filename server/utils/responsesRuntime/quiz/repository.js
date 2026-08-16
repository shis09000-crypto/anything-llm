const crypto = require("crypto");
const prisma = require("../../prisma");
const { sha256 } = require("../contract");

const QUIZ_SCOPE_PREFIX = "quiz:";
const QUIZ_CONVERSATION_TYPE = "quiz";

function quizConversationId() {
  return `ath_quiz_${crypto.randomUUID().replace(/-/g, "")}`;
}

function stateResponseId(quizId) {
  return `resp_quiz_${String(quizId).replace(/^ath_quiz_/, "")}_${crypto
    .randomUUID()
    .replace(/-/g, "")}`;
}

function quizScopeKey(id) {
  return `${QUIZ_SCOPE_PREFIX}${id}`;
}

function stateResponseData({ id, conversationId, ownerUserId, state, status }) {
  const hash = sha256(state);
  return {
    response: {
      id,
      conversationId,
      chatRunId: conversationId,
      ownerUserId,
      taskPriority: "P0",
      taskIntent: "quiz_state",
      provider: "athena",
      model: "responses-quiz-v1",
      requestedProtocol: "responses",
      effectiveProtocol: "responses",
      status,
      background: false,
      store: true,
      inputHash: hash,
      usageJson: JSON.stringify({ schema: "athena.responses.quiz-state.v1" }),
      resultSha256: hash,
      completedAt: new Date(),
    },
    checkpoint: {
      responseId: id,
      stateCiphertext: JSON.stringify(state),
      stateHash: hash,
    },
  };
}

class ResponsesQuizRepository {
  constructor({ client = prisma } = {}) {
    this.client = client;
  }

  nextId() {
    return quizConversationId();
  }

  async create({
    id = this.nextId(),
    workspaceId,
    threadId = null,
    ownerUserId = null,
    state,
  }) {
    const headId = stateResponseId(id);
    const record = stateResponseData({
      id: headId,
      conversationId: id,
      ownerUserId,
      state,
      status: "completed",
    });
    return this.client.$transaction(
      async (tx) => {
        const conversation = await tx.responses_conversations.create({
          data: {
            id,
            scopeKey: quizScopeKey(id),
            workspaceId,
            threadId,
            ownerUserId,
            status: "generating",
          },
        });
        await tx.responses.create({ data: record.response });
        await tx.response_checkpoints.create({ data: record.checkpoint });
        await tx.responses_conversations.update({
          where: { id },
          data: { currentHeadResponseId: headId },
        });
        return { ...conversation, currentHeadResponseId: headId };
      },
      { maxWait: 30_000, timeout: 30_000 }
    );
  }

  async find(id) {
    const row = await this.client.responses_conversations.findUnique({
      where: { id: String(id) },
    });
    if (!row || row.deletedAt || row.scopeKey !== quizScopeKey(id)) return null;
    return row;
  }

  async read(row) {
    if (!row?.currentHeadResponseId) return null;
    const checkpoint = await this.client.response_checkpoints.findUnique({
      where: { responseId: row.currentHeadResponseId },
    });
    if (!checkpoint?.stateCiphertext) return null;
    try {
      return JSON.parse(String(checkpoint.stateCiphertext));
    } catch {
      throw Object.assign(new Error("quiz_state_json_invalid"), {
        httpStatus: 500,
      });
    }
  }

  async write(row, state, status = row.status) {
    const headId = stateResponseId(row.id);
    const record = stateResponseData({
      id: headId,
      conversationId: row.id,
      ownerUserId: row.ownerUserId ?? null,
      state,
      status: "completed",
    });
    try {
      await this.client.$transaction(
        async (tx) => {
          const advanced = await tx.responses_conversations.updateMany({
            where: {
              id: row.id,
              currentHeadResponseId: row.currentHeadResponseId,
              deletedAt: null,
            },
            data: {
              currentHeadResponseId: headId,
              status,
              lastUpdatedAt: new Date(),
            },
          });
          if (advanced.count !== 1)
            throw Object.assign(new Error("quiz_state_conflict"), {
              code: "QUIZ_STATE_CONFLICT",
            });
          await tx.responses.create({ data: record.response });
          await tx.response_checkpoints.create({ data: record.checkpoint });
        },
        { maxWait: 30_000, timeout: 30_000 }
      );
      return headId;
    } catch (failure) {
      if (failure?.code === "QUIZ_STATE_CONFLICT") return null;
      throw failure;
    }
  }

  async mutate(id, updater, { attempts = 5 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const row = await this.find(id);
      if (!row)
        throw Object.assign(new Error("quiz_not_found"), { httpStatus: 404 });
      const current = await this.read(row);
      const change = await updater(current, row);
      if (!change) return { row, state: current };
      const state = change.state || change;
      const status = change.status || row.status;
      const currentHeadResponseId = await this.write(row, state, status);
      if (currentHeadResponseId) {
        return {
          row: { ...row, currentHeadResponseId, status },
          state,
        };
      }
    }
    throw Object.assign(new Error("quiz_state_conflict"), { httpStatus: 409 });
  }

  async list({
    workspaceId,
    threadId = null,
    ownerUserId = null,
    limit = 100,
  }) {
    return this.client.responses_conversations.findMany({
      where: {
        scopeKey: { startsWith: QUIZ_SCOPE_PREFIX },
        workspaceId: Number(workspaceId),
        threadId: threadId === null ? null : Number(threadId),
        ownerUserId:
          ownerUserId === null || ownerUserId === undefined
            ? null
            : Number(ownerUserId),
        deletedAt: null,
      },
      orderBy: { createdAt: "asc" },
      take: Math.max(1, Math.min(Number(limit) || 100, 250)),
    });
  }
}

module.exports = {
  QUIZ_CONVERSATION_TYPE,
  QUIZ_SCOPE_PREFIX,
  ResponsesQuizRepository,
  quizConversationId,
  quizScopeKey,
  stateResponseData,
  stateResponseId,
};
