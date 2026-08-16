const crypto = require("crypto");
const { requestFastLane } = require("../../../athena3dCenter/fastLane");

function gatewayUrl(env = process.env) {
  return String(
    env.ATHENA_3D_CONTEXT_FAST_LANE_URL || "http://127.0.0.1:3118"
  ).replace(/\/+$/, "");
}

function templateHash(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex");
}

class GatewayContextClient {
  constructor({ env = process.env } = {}) {
    this.env = env;
  }

  enabled() {
    return (
      this.env.ATHENA_3D_CONTEXT_FAST_LANE_ENABLED !== "false" &&
      gatewayUrl(this.env).length > 0
    );
  }

  call(operation, payload, timeoutMs = 10_000) {
    if (!this.enabled()) {
      const error = new Error("athena_3d_context_fast_lane_required");
      error.code = "athena_3d_context_fast_lane_required";
      error.httpStatus = 503;
      throw error;
    }
    return requestFastLane({
      url: `${gatewayUrl(this.env)}/v1/dispatch`,
      operation,
      payload,
      timeoutMs,
    });
  }

  install({ sessionId, contextRef, memoryPoint, template, status }) {
    return this.call("context.install", {
      session_id: sessionId,
      context_ref: contextRef,
      memory_point: memoryPoint,
      stable_instructions: template.stableInstructions,
      context_prefix: template.contextPrefix,
      template_hash: templateHash(template.stableInstructions),
      status,
    });
  }

  complete({ contextRef, input, completion, template }) {
    return this.call(
      "context.complete",
      {
        context_ref: contextRef,
        template_hash: templateHash(template.stableInstructions),
        input,
        completion,
      },
      300_000
    );
  }

  commit(payload) {
    return this.call("context.commit", payload, 30_000);
  }

  finalize(payload) {
    return this.call("context.finalize", payload, 300_000);
  }

  status(payload) {
    return this.call("context.status", payload);
  }

  invalidate(payload) {
    return this.call("context.invalidate", payload);
  }
}

module.exports = { GatewayContextClient, gatewayUrl, templateHash };
