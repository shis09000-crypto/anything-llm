const prisma = require("../prisma");
const { performanceError } = require("./contract");
const { deserialize, payloadHash, serialize } = require("./storage");

function assertScope(row, scope) {
  if (
    Number(row.workspaceId) !== Number(scope.workspaceId) ||
    (row.threadId != null && Number(row.threadId) !== Number(scope.threadId)) ||
    (row.ownerUserId != null &&
      Number(row.ownerUserId) !== Number(scope.ownerUserId))
  )
    throw performanceError("performance_session_forbidden", 403);
  return row;
}

class CharacterPerformanceRepository {
  constructor({ client = prisma, env = process.env } = {}) {
    this.client = client;
    this.env = env;
  }

  async createSession(data, clientProfile) {
    return this.client.character_performance_sessions.create({
      data: {
        ...data,
        clientJson: serialize(clientProfile),
        clientHash: payloadHash(clientProfile),
      },
    });
  }

  async findSession(id, scope = null) {
    const row = await this.client.character_performance_sessions.findUnique({
      where: { id },
    });
    if (!row) throw performanceError("performance_session_not_found", 404);
    return scope ? assertScope(row, scope) : row;
  }

  async findSessionForOwner(id, ownerUserId = null) {
    const row = await this.client.character_performance_sessions.findUnique({
      where: { id },
    });
    if (!row) throw performanceError("performance_session_not_found", 404);
    if (
      row.ownerUserId != null &&
      Number(row.ownerUserId) !== Number(ownerUserId)
    )
      throw performanceError("performance_session_forbidden", 403);
    return row;
  }

  async readClient(row) {
    return deserialize(row.clientJson, `${row.id}:client`, this.env);
  }

  async linkConversation(id, conversationId, scope) {
    const row = await this.findSession(id, scope);
    if (row.conversationId && row.conversationId !== conversationId)
      throw performanceError("performance_conversation_already_linked", 409);
    return this.client.character_performance_sessions.update({
      where: { id },
      data: { conversationId },
    });
  }

  async savePlan(session, plan) {
    const existing = await this.findPlanByResponse(
      session.id,
      plan.response_id
    );
    if (existing) return this.readPlan(existing);
    await this.client.character_performance_plans.create({
      data: {
        id: plan.id,
        sessionId: session.id,
        responseId: plan.response_id,
        sequenceId: plan.sequence_id,
        status: plan.status,
        planJson: serialize(plan),
        planHash: payloadHash(plan),
        commandCount: plan.commands.length,
      },
    });
    return plan;
  }

  async findPlanByResponse(sessionId, responseId) {
    return this.client.character_performance_plans.findUnique({
      where: { sessionId_responseId: { sessionId, responseId } },
    });
  }

  async findPlan(id, sessionId = null) {
    const row = await this.client.character_performance_plans.findUnique({
      where: { id },
    });
    if (!row || (sessionId && row.sessionId !== sessionId))
      throw performanceError("performance_plan_not_found", 404);
    return row;
  }

  async latestPlan(sessionId) {
    return this.client.character_performance_plans.findFirst({
      where: { sessionId },
      orderBy: { createdAt: "desc" },
    });
  }

  async readPlan(row) {
    const plan = await deserialize(row.planJson, `${row.id}:plan`, this.env);
    if (payloadHash(plan) !== row.planHash)
      throw performanceError("performance_plan_integrity_failed", 500);
    return plan;
  }

  async updatePlan(id, data) {
    return this.client.character_performance_plans.update({
      where: { id },
      data,
    });
  }

  async appendEvent({
    sessionId,
    eventType,
    planId = null,
    commandId = null,
    payload,
  }) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const session = await this.findSession(sessionId);
      const sequence = session.lastSequence + 1;
      const payloadJson = serialize(payload);
      try {
        return await this.client.$transaction(async (tx) => {
          const advanced = await tx.character_performance_sessions.updateMany({
            where: { id: sessionId, lastSequence: session.lastSequence },
            data: { lastSequence: sequence },
          });
          if (advanced.count !== 1)
            throw performanceError("performance_event_race", 409);
          const row = await tx.character_performance_events.create({
            data: {
              sessionId,
              sequence,
              eventType,
              planId,
              commandId,
              payloadJson,
              payloadHash: payloadHash(payload),
            },
          });
          return { ...row, payload };
        });
      } catch (error) {
        if (error.code !== "performance_event_race" && error.code !== "P2002")
          throw error;
      }
    }
    throw performanceError("performance_event_sequence_conflict", 409);
  }

  async listEvents(sessionId, after = -1) {
    const rows = await this.client.character_performance_events.findMany({
      where: { sessionId, sequence: { gt: Number(after) } },
      orderBy: { sequence: "asc" },
      take: 1000,
    });
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        payload: await deserialize(
          row.payloadJson,
          `${sessionId}:event:${row.sequence}`,
          this.env
        ),
      }))
    );
  }

  async findFeedback(id) {
    return this.client.character_performance_feedback.findUnique({
      where: { id },
    });
  }

  async latestFeedback(planId, commandId) {
    return this.client.character_performance_feedback.findFirst({
      where: { planId, commandId },
      orderBy: { createdAt: "desc" },
    });
  }

  async saveFeedback(sessionId, planId, event) {
    return this.client.character_performance_feedback.create({
      data: {
        id: event.event_id,
        sessionId,
        planId,
        commandId: event.command_id,
        status: event.status,
        actualStartMs: event.actual_start_ms,
        actualDurationMs: event.actual_duration_ms,
        errorCode: event.error_code,
        payloadJson: serialize(event),
        payloadHash: payloadHash(event),
      },
    });
  }

  async cancelSession(id, scope) {
    await this.findSession(id, scope);
    return this.client.character_performance_sessions.update({
      where: { id },
      data: { status: "cancelled", cancelledAt: new Date() },
    });
  }
}

module.exports = { CharacterPerformanceRepository, assertScope };
