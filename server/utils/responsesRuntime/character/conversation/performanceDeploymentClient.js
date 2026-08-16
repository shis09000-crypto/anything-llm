const crypto = require("crypto");
const { requestInternalService } = require("../../../microModules");

function baseUrl(env = process.env) {
  const value = String(
    env.ATHENA_CHARACTER_PERFORMANCE_RUNTIME_URL || ""
  ).replace(/\/+$/, "");
  if (!value) {
    const error = new Error("character_performance_runtime_url_missing");
    error.code = "character_performance_runtime_url_missing";
    throw error;
  }
  return value;
}

class PerformanceDeploymentClient {
  constructor({ env = process.env, request = requestInternalService } = {}) {
    this.env = env;
    this.request = request;
  }

  enabled() {
    return this.env.ATHENA_CHARACTER_PERFORMANCE_RUNTIME_CUTOVER === "true";
  }

  async compile({ sessionId, conversationId, record, scope }) {
    if (!this.enabled() || !sessionId) return null;
    const body = {
      conversation_id: conversationId,
      response: record.response,
      resolution: record.resolution,
      scope: {
        workspace_id: scope.workspaceId,
        thread_id: scope.threadId,
        owner_user_id: scope.ownerUserId,
      },
    };
    const response = await this.request({
      callerRole: "responses-runtime",
      targetModule: "character-performance-runtime",
      capability: "character-performance.plans.compile",
      contractVersion: "1.0",
      method: "POST",
      url: `${baseUrl(this.env)}/internal/v1/character-performance/sessions/${encodeURIComponent(sessionId)}/plans`,
      body,
      idempotencyKey: crypto
        .createHash("sha256")
        .update(`${sessionId}:${record.response.id}`)
        .digest("hex"),
      env: this.env,
      timeoutMs: 30_000,
    });
    return response.plan;
  }
}

module.exports = { PerformanceDeploymentClient, baseUrl };
