const { requestFastLane } = require("../../../athena3dCenter/fastLane");

function enabled(env = process.env) {
  return (
    String(
      env.ATHENA_3D_MEMORY_ENABLED ??
        (env.NODE_ENV === "test" ? "false" : "true")
    ) === "true"
  );
}

function fastLaneUrl(env = process.env) {
  return String(
    env.ATHENA_3D_MEMORY_FAST_LANE_URL || "http://127.0.0.1:3116"
  ).replace(/\/+$/, "");
}

function fastLaneEnabled(env = process.env) {
  return (
    enabled(env) &&
    env.ATHENA_3D_FAST_LANE_ENABLED !== "false" &&
    fastLaneUrl(env).length > 0
  );
}

async function call(
  operation,
  body,
  { timeoutMs = 30_000, env = process.env } = {}
) {
  if (!enabled(env)) return null;
  if (!fastLaneEnabled(env)) {
    const error = new Error("athena_3d_memory_fast_lane_required");
    error.code = "athena_3d_memory_fast_lane_required";
    error.httpStatus = 503;
    throw error;
  }
  return requestFastLane({
    url: `${fastLaneUrl(env)}/v1/dispatch`,
    operation,
    payload: body,
    timeoutMs,
  });
}

class ThreeDSessionMemoryClient {
  constructor({ env = process.env } = {}) {
    this.env = env;
  }

  enabled() {
    return enabled(this.env);
  }

  async createSession(body) {
    const response = await call("memory.session.create", body, {
      env: this.env,
    });
    return response?.session || response || null;
  }

  async contextResolve(body) {
    const response = await call("memory.context.resolve", body, {
      timeoutMs: 30_000,
      env: this.env,
    });
    return response?.context || response || null;
  }

  async contextPrepare(body) {
    const response = await call("memory.context.prepare", body, {
      timeoutMs: 30_000,
      env: this.env,
    });
    return response?.context || response || null;
  }

  async commitTurn(body) {
    const response = await call("memory.turn.commit", body, {
      timeoutMs: 120_000,
      env: this.env,
    });
    return response?.commit || response || null;
  }

  async status(body) {
    const response = await call("memory.status", body, { env: this.env });
    return response?.status && typeof response.status === "object"
      ? response.status
      : response || null;
  }

  async deleteSession(body) {
    const response = await call("memory.session.delete", body, {
      env: this.env,
    });
    return response?.deletion || response || null;
  }

  async archiveLongTerm(body) {
    return call("memory.long_term.archive.prepare", body, {
      timeoutMs: 30_000,
      env: this.env,
    });
  }

  async finalizeLongTerm(body) {
    return call("memory.long_term.finalize.commit", body, {
      timeoutMs: 300_000,
      env: this.env,
    });
  }

  async longTermContext(body) {
    return call("memory.long_term.context.resolve", body, { env: this.env });
  }

  async freezeLongTermRecall(body) {
    const response = await call("memory.long_term.recall.freeze", body, {
      env: this.env,
    });
    return response?.recall || response || null;
  }
}

module.exports = {
  ThreeDSessionMemoryClient,
  enabled,
  fastLaneEnabled,
  fastLaneUrl,
};
