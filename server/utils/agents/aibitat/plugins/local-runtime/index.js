const crypto = require("crypto");
const { lazyDataAccessFacade } = require("../../../../dataAccess/lazyFacade");
const { riskFor } = require("../../../../localRuntime/policy");
const {
  invokeLocalRuntimeTool,
  localRuntimeToolBrokerEnabled,
} = require("../../../../toolRuntime/remoteClient");

const ToolInvocation = lazyDataAccessFacade("toolInvocation");
const SKILL_NAME = "local-runtime-agent";
const RESULT_POLICY = "local-runtime/sanitized-result-only";
const APPROVAL_CLASS = "local-runtime-step-up";

function invocationOwner(aibitat) {
  const invocation = aibitat.handlerProps?.invocation || {};
  const userId = Number(invocation.user_id);
  if (!invocation.uuid || !Number.isSafeInteger(userId) || userId < 1)
    throw new Error("local_runtime_agent_owner_unavailable");
  return { invocation, userId };
}

function attachFrame(result, aibitat) {
  const frame = result?.ephemeralFrame;
  const encoded = String(frame?.data || "").trim();
  if (!encoded) return result;
  const buffer = Buffer.from(encoded, "base64");
  if (!buffer.length) return { ...result, ephemeralFrame: undefined };
  const mimeType = frame.mimeType || "image/jpeg";
  aibitat.addToolAttachment?.({
    kind: "ephemeral",
    source: "computer_use",
    name: `local-runtime-${Date.now()}.jpg`,
    mime: mimeType,
    mimeType,
    dataUrl: `data:${mimeType};base64,${encoded}`,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    capturedAt: frame.capturedAt || new Date().toISOString(),
    detail: "original",
    retention: "turn",
  });
  const next = { ...result };
  delete next.ephemeralFrame;
  next.screenshot = {
    mimeType,
    byteSize: buffer.length,
    retention: "turn",
    capturedAt: frame.capturedAt || new Date().toISOString(),
  };
  return next;
}

function createLocalRuntimeTool({ name, description, parameters }) {
  return {
    name,
    description,
    startupConfig: { params: {} },
    resultPolicy: RESULT_POLICY,
    plugin: function () {
      return {
        name,
        setup(aibitat) {
          aibitat.function({
            super: aibitat,
            name,
            description,
            resultPolicy: RESULT_POLICY,
            parameters: {
              $schema: "http://json-schema.org/draft-07/schema#",
              ...parameters,
            },
            handler: async function (input = {}) {
              const { invocation, userId } = invocationOwner(this.super);
              const risk = riskFor(name, input);
              if (risk.level === "L4")
                return JSON.stringify({
                  success: false,
                  error: risk.reasonCode,
                });
              let approvalRequestId = null;
              const scope = {
                deviceId: input.deviceId || null,
                risk: risk.level,
                priority: input.priority || "P2",
                responseId: invocation.responseId || null,
              };
              try {
                if (risk.approvalRequired) {
                  if (typeof this.super.requestToolApproval !== "function")
                    throw new Error(
                      "local_runtime_step_up_context_unavailable"
                    );
                  const approval = await this.super.requestToolApproval({
                    skillName: name,
                    payload: scope,
                    description: "此本地操作需要通行密钥二次确认。",
                    forceApproval: true,
                    allowAlwaysAllow: false,
                    approvalClass: APPROVAL_CLASS,
                  });
                  if (!approval.approved)
                    return JSON.stringify({
                      success: false,
                      error: "local_runtime_step_up_denied",
                    });
                  approvalRequestId = approval.requestId;
                  await ToolInvocation.startExecution({
                    approvalRequestId,
                    agentInvocationId: invocation.uuid,
                    toolName: name,
                    scope,
                    args: input,
                  });
                } else {
                  const automatic =
                    await ToolInvocation.startAutomaticExecution({
                      agentInvocationId: invocation.uuid,
                      clientTurnId: invocation.clientTurnId,
                      ownerUserId: userId,
                      toolName: name,
                      approvalClass: "local-runtime-lease",
                      scope,
                      args: input,
                    });
                  approvalRequestId = automatic.approvalRequestId;
                }
                const result = await (localRuntimeToolBrokerEnabled()
                  ? invokeLocalRuntimeTool({
                      approvalRequestId,
                      toolName: name,
                      args: input,
                    })
                  : require("../../../../toolRuntime/broker").dispatchLocalRuntime(
                      {
                        approvalRequestId,
                        toolName: name,
                        args: input,
                      }
                    ));
                const safeResult = attachFrame(result, this.super);
                await ToolInvocation.completeExecution({
                  approvalRequestId,
                  result: safeResult,
                });
                return JSON.stringify(safeResult);
              } catch (error) {
                if (approvalRequestId)
                  await ToolInvocation.failExecution({
                    approvalRequestId,
                    reasonCode:
                      error.code ||
                      error.message ||
                      "local_runtime_tool_failed",
                  }).catch(() => false);
                return JSON.stringify({
                  success: false,
                  error: String(
                    error.code || error.message || "local_runtime_tool_failed"
                  ).slice(0, 160),
                });
              }
            },
          });
        },
      };
    },
  };
}

const common = {
  deviceId: {
    type: "string",
    minLength: 1,
    description: "Paired local Runtime device ID.",
  },
};

const localRuntimeTools = [
  createLocalRuntimeTool({
    name: "local_device_status",
    description:
      "Read the health and granted capabilities of the owner's paired local Mac.",
    parameters: {
      type: "object",
      properties: common,
      required: ["deviceId"],
      additionalProperties: false,
    },
  }),
  createLocalRuntimeTool({
    name: "local_desktop_observe",
    description:
      "Capture the owner's current unlocked Mac desktop as a turn-scoped visual frame.",
    parameters: {
      type: "object",
      properties: { ...common, displayId: { type: "string" } },
      required: ["deviceId"],
      additionalProperties: false,
    },
  }),
  createLocalRuntimeTool({
    name: "local_desktop_act",
    description:
      "Perform one allowed click, pointer, scroll, key, typing, or app-open action on the owner's Mac.",
    parameters: {
      type: "object",
      properties: {
        ...common,
        action: {
          type: "string",
          enum: [
            "click",
            "double_click",
            "move",
            "scroll",
            "key",
            "type",
            "open_app",
          ],
        },
        x: { type: "number" },
        y: { type: "number" },
        deltaX: { type: "number" },
        deltaY: { type: "number" },
        text: { type: "string", maxLength: 10000 },
        key: { type: "string", maxLength: 80 },
        app: { type: "string", maxLength: 160 },
      },
      required: ["deviceId", "action"],
      additionalProperties: false,
    },
  }),
  createLocalRuntimeTool({
    name: "local_file_read",
    description:
      "Read a file inside a directory explicitly granted by the local device owner.",
    parameters: {
      type: "object",
      properties: {
        ...common,
        path: { type: "string" },
        maxBytes: { type: "integer", minimum: 1, maximum: 1048576 },
      },
      required: ["deviceId", "path"],
      additionalProperties: false,
    },
  }),
  createLocalRuntimeTool({
    name: "local_file_write",
    description:
      "Create or replace a file inside a directory explicitly granted by the local device owner.",
    parameters: {
      type: "object",
      properties: {
        ...common,
        path: { type: "string" },
        content: { type: "string", maxLength: 1048576 },
        createOnly: { type: "boolean" },
      },
      required: ["deviceId", "path", "content"],
      additionalProperties: false,
    },
  }),
  createLocalRuntimeTool({
    name: "local_command_run",
    description:
      "Run a bounded command in the Codex sandbox rooted at an owner-approved local directory.",
    parameters: {
      type: "object",
      properties: {
        ...common,
        cwd: { type: "string" },
        command: { type: "string", maxLength: 16000 },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
        background: { type: "boolean" },
      },
      required: ["deviceId", "cwd", "command"],
      additionalProperties: false,
    },
  }),
  createLocalRuntimeTool({
    name: "local_job_cancel",
    description:
      "Cancel an active local Runtime job owned by the current Athena user.",
    parameters: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
      additionalProperties: false,
    },
  }),
];

const localRuntimeAgent = {
  name: SKILL_NAME,
  conditional: true,
  approvalRequired: true,
  startupConfig: { params: {} },
  plugin: localRuntimeTools,
};

module.exports = {
  APPROVAL_CLASS,
  RESULT_POLICY,
  SKILL_NAME,
  localRuntimeAgent,
  localRuntimeTools,
};
