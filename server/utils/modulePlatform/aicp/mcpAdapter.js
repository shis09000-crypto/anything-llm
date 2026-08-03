const { createAicpEnvelope } = require("./envelope");

function phase0McpTools(
  registry,
  { principalAssertionId, scopes = [], authorize = null } = {}
) {
  const call = async ({ capability, callType, target, payload = {} }) => {
    const envelope = createAicpEnvelope({
      callType,
      capability,
      producer: "mcp-adapter",
      target,
      auth: { principalAssertionId, scopes },
      payload,
    });
    if (typeof authorize !== "function") {
      const error = new Error("aicp_mcp_authorizer_required");
      error.code = "AICP_MCP_AUTHORIZER_REQUIRED";
      error.httpStatus = 401;
      throw error;
    }
    const authorization = await authorize(envelope);
    return registry.dispatch(envelope, {
      principalVerified: authorization?.verified === true,
      authorizedScopes: Array.isArray(authorization?.scopes)
        ? authorization.scopes
        : [],
    });
  };
  return [
    {
      name: "athena_module_describe",
      description:
        "Return the deterministic, metadata-only description of one registered Athena module.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["moduleId"],
        properties: {
          moduleId: {
            type: "string",
            pattern: "^[a-z0-9][a-z0-9-]{1,62}$",
          },
        },
      },
      readOnlyHint: true,
      handler: ({ moduleId }) =>
        call({
          capability: "module.describe",
          callType: "Describe",
          target: moduleId,
        }),
    },
    {
      name: "athena_module_self_test",
      description:
        "Run the side-effect-free contract and readiness self-test for one Athena module.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["moduleId"],
        properties: {
          moduleId: {
            type: "string",
            pattern: "^[a-z0-9][a-z0-9-]{1,62}$",
          },
        },
      },
      readOnlyHint: true,
      handler: ({ moduleId }) =>
        call({
          capability: "module.self-test",
          callType: "SelfTest",
          target: moduleId,
        }),
    },
  ];
}

module.exports = { phase0McpTools };
