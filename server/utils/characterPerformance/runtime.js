const { PROFILE } = require("../responsesRuntime/character/v2/profile");
const {
  identifier,
  normalizeScope,
  performanceError,
  validateFeedback,
  validateSessionRequest,
} = require("./contract");
const { compilePerformancePlan } = require("./compiler");
const { PerformancePackRegistry } = require("./packRegistry");
const { CharacterPerformanceRepository } = require("./repository");

function publicSession(row) {
  return {
    id: row.id,
    object: "character.performance.session",
    status: row.status,
    character: {
      character_id: row.characterId,
      instance_id: row.characterInstanceId,
    },
    conversation_id: row.conversationId,
    adapter: row.adapter,
    runtime_version: row.runtimeVersion,
    pack_ref: {
      id: row.packId,
      version: row.packVersion,
      sha256: row.packSha256,
    },
    last_sequence: row.lastSequence,
    created_at: row.createdAt?.getTime?.() ?? row.createdAt,
  };
}

function publicEvent(row) {
  return {
    type: row.eventType,
    event_id: `chr_perf_evt_${row.id}`,
    sequence_number: row.sequence,
    session_id: row.sessionId,
    plan_id: row.planId,
    command_id: row.commandId,
    created_at: row.createdAt?.getTime?.() ?? row.createdAt,
    ...row.payload,
  };
}

class CharacterPerformanceRuntime {
  constructor({
    repository,
    registry,
    profile = PROFILE,
    env = process.env,
  } = {}) {
    this.repository = repository || new CharacterPerformanceRepository({ env });
    this.registry = registry || new PerformancePackRegistry({ env }).load();
    this.profile = profile;
  }

  snapshot() {
    return {
      ready: true,
      protocol: "1.0",
      adapters: ["mock.anatomy.v1"],
      packCount: this.registry.list().length,
      trackCount: 13,
      storageMode: "plaintext_json",
      keyCustodyOnHotPath: false,
    };
  }

  pack(packId) {
    return this.registry.get(packId);
  }

  async createSession(body) {
    const request = validateSessionRequest(body);
    const pack = this.registry.select({
      characterId: request.characterId,
      adapter: request.clientProfile.adapter,
      runtimeVersion: request.clientProfile.runtime_version,
      manifestRef: {
        id: this.profile.manifest.id,
        version: this.profile.manifest.version,
        sha256: this.profile.manifest.integrity.sha256,
      },
      installedAssets: request.clientProfile.installed_assets,
    });
    const row = await this.repository.createSession(
      {
        id: identifier("chr_perf_session"),
        workspaceId: request.scope.workspaceId,
        threadId: request.scope.threadId,
        ownerUserId: request.scope.ownerUserId,
        conversationId: request.conversationId,
        characterId: request.characterId,
        characterInstanceId: request.characterInstanceId,
        status: "active",
        adapter: request.clientProfile.adapter,
        runtimeVersion: request.clientProfile.runtime_version,
        packId: pack.id,
        packVersion: pack.version,
        packSha256: pack.integrity.sha256,
      },
      request.clientProfile
    );
    await this.repository.appendEvent({
      sessionId: row.id,
      eventType: "character.performance.session.created",
      payload: { session: publicSession(row) },
    });
    return publicSession(await this.repository.findSession(row.id));
  }

  async retrieve(sessionId, scopeInput) {
    const scope = normalizeScope(scopeInput);
    const row = await this.repository.findSession(sessionId, scope);
    const latest = await this.repository.latestPlan(sessionId);
    return {
      ...publicSession(row),
      latest_plan: latest ? await this.repository.readPlan(latest) : null,
    };
  }

  async resolveScope(sessionId, ownerUserId = null) {
    const row = await this.repository.findSessionForOwner(
      sessionId,
      ownerUserId
    );
    return {
      workspace_id: row.workspaceId,
      thread_id: row.threadId,
      owner_user_id: row.ownerUserId,
      conversation_id: row.conversationId,
    };
  }

  async link(sessionId, body) {
    if (!body.conversation_id)
      throw performanceError("performance_conversation_required");
    const row = await this.repository.linkConversation(
      sessionId,
      String(body.conversation_id),
      normalizeScope(body.scope || body.athena)
    );
    return publicSession(row);
  }

  async submitPlan(sessionId, body) {
    const scope = normalizeScope(body.scope || body.athena);
    const session = await this.repository.findSession(sessionId, scope);
    if (session.status !== "active")
      throw performanceError("performance_session_not_active", 409);
    const pack = this.registry.get(session.packId);
    if (pack.integrity.sha256 !== session.packSha256)
      throw performanceError("performance_pack_reference_drift", 409);
    const existing = await this.repository.findPlanByResponse?.(
      sessionId,
      body.response?.id
    );
    if (existing) return this.repository.readPlan(existing);
    const plan = compilePerformancePlan({
      session,
      response: body.response,
      resolution: body.resolution,
      pack,
    });
    const stored = await this.repository.savePlan(session, plan);
    await this.repository.appendEvent({
      sessionId,
      eventType: "character.performance.plan.compiled",
      planId: stored.id,
      payload: { plan: stored },
    });
    return stored;
  }

  async events(sessionId, after, scopeInput) {
    const scope = normalizeScope(scopeInput);
    await this.repository.findSession(sessionId, scope);
    const rows = await this.repository.listEvents(sessionId, after);
    return rows.map(publicEvent);
  }

  async feedback(sessionId, body) {
    const scope = normalizeScope(body.scope || body.athena);
    await this.repository.findSession(sessionId, scope);
    const planRow = body.plan_id
      ? await this.repository.findPlan(body.plan_id, sessionId)
      : await this.repository.latestPlan(sessionId);
    if (!planRow) throw performanceError("performance_plan_not_found", 404);
    const plan = await this.repository.readPlan(planRow);
    const commands = new Set(
      plan.commands.map((command) => command.command_id)
    );
    const accepted = [];
    const observedStatus = new Map();
    for (const event of validateFeedback(body)) {
      if (!commands.has(event.command_id))
        throw performanceError("performance_feedback_command_forged", 403);
      const duplicate = await this.repository.findFeedback(event.event_id);
      if (duplicate) {
        if (duplicate.sessionId !== sessionId)
          throw performanceError("performance_feedback_event_conflict", 409);
        accepted.push({ event_id: event.event_id, duplicate: true });
        continue;
      }
      const previous =
        observedStatus.get(event.command_id) ||
        (await this.repository.latestFeedback?.(plan.id, event.command_id))
          ?.status ||
        null;
      if (["completed", "failed", "cancelled"].includes(previous))
        throw performanceError("performance_feedback_command_terminal", 409);
      if (event.status === "completed" && previous !== "started")
        throw performanceError("performance_feedback_transition_invalid", 409);
      await this.repository.saveFeedback(sessionId, plan.id, event);
      observedStatus.set(event.command_id, event.status);
      await this.repository.appendEvent({
        sessionId,
        eventType: `character.execution.${event.status}`,
        planId: plan.id,
        commandId: event.command_id,
        payload: event,
      });
      accepted.push({ event_id: event.event_id, duplicate: false });
    }
    return { accepted };
  }

  async cancel(sessionId, body) {
    const scope = normalizeScope(body.scope || body.athena);
    const existing = await this.repository.findSession(sessionId, scope);
    if (existing.status === "cancelled") return publicSession(existing);
    const row = await this.repository.cancelSession(sessionId, scope);
    await this.repository.appendEvent({
      sessionId,
      eventType: "character.performance.session.cancelled",
      payload: { reason: body.reason || "client_cancelled" },
    });
    return publicSession(row);
  }
}

module.exports = { CharacterPerformanceRuntime, publicEvent, publicSession };
