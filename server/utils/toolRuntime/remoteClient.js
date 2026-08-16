const { requestInternalService } = require("../microModules/internalClient");

function cryptoAccountToolBrokerEnabled(env = process.env) {
  return (
    env.ATHENA_CRYPTO_ACCOUNT_CUTOVER === "true" &&
    Boolean(String(env.ATHENA_TOOL_BROKER_URL || "").trim()) &&
    ["agent-runtime", "scheduler", "background-worker"].includes(
      String(env.ATHENA_RUNTIME_ROLE || "").toLowerCase()
    )
  );
}

function browserToolBrokerEnabled(env = process.env) {
  return (
    Boolean(String(env.ATHENA_TOOL_BROKER_URL || "").trim()) &&
    ["agent-runtime", "scheduler", "background-worker"].includes(
      String(env.ATHENA_RUNTIME_ROLE || "").toLowerCase()
    )
  );
}

async function invokeCryptoAccountTool({
  approvalRequestId,
  toolName,
  args = {},
  env = process.env,
} = {}) {
  const baseUrl = String(env.ATHENA_TOOL_BROKER_URL).replace(/\/+$/, "");
  const response = await requestInternalService({
    callerRole: String(env.ATHENA_RUNTIME_ROLE),
    targetModule: "tool-runtime",
    capability: "tool.invoke",
    contractVersion: "1.0",
    url: `${baseUrl}/internal/v1/tools/invoke`,
    body: {
      approvalRequestId,
      toolName,
      args,
    },
    idempotencyKey: approvalRequestId,
    env,
    timeoutMs: Number(env.ATHENA_TOOL_INVOCATION_TIMEOUT_MS || 120_000),
  });
  return response.result;
}

async function invokeBrowserTool({
  approvalRequestId,
  toolName,
  args = {},
  env = process.env,
} = {}) {
  const baseUrl = String(env.ATHENA_TOOL_BROKER_URL).replace(/\/+$/, "");
  const response = await requestInternalService({
    callerRole: String(env.ATHENA_RUNTIME_ROLE),
    targetModule: "tool-runtime",
    capability: "tool.invoke",
    contractVersion: "1.0",
    url: `${baseUrl}/internal/v1/tools/invoke`,
    body: { approvalRequestId, toolName, args },
    idempotencyKey: approvalRequestId,
    env,
    timeoutMs: Number(env.ATHENA_TOOL_INVOCATION_TIMEOUT_MS || 120_000),
  });
  return response.result;
}

module.exports = {
  browserToolBrokerEnabled,
  cryptoAccountToolBrokerEnabled,
  invokeCryptoAccountTool,
  invokeBrowserTool,
};
