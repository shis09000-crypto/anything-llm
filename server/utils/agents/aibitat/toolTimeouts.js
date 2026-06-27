const DEFAULT_TOOL_EXECUTION_TIMEOUT_MS = 30 * 1_000;
const REQUEST_USER_INPUT_TOOL_NAME = "request-user-input";
const REQUEST_USER_INPUT_TOOL_EXECUTION_TIMEOUT_MS = 185 * 1_000;

function agentToolExecutionTimeoutMs(env = process.env) {
  const envTimeout = parseInt(env.AGENT_TOOL_TIMEOUT_MS, 10);
  return !isNaN(envTimeout) && envTimeout > 0
    ? envTimeout
    : DEFAULT_TOOL_EXECUTION_TIMEOUT_MS;
}

function toolExecutionTimeoutMs(name = "", env = process.env) {
  const timeoutMs = agentToolExecutionTimeoutMs(env);
  if (name === REQUEST_USER_INPUT_TOOL_NAME) {
    return Math.max(timeoutMs, REQUEST_USER_INPUT_TOOL_EXECUTION_TIMEOUT_MS);
  }
  return timeoutMs;
}

module.exports = {
  agentToolExecutionTimeoutMs,
  toolExecutionTimeoutMs,
  DEFAULT_TOOL_EXECUTION_TIMEOUT_MS,
  REQUEST_USER_INPUT_TOOL_NAME,
  REQUEST_USER_INPUT_TOOL_EXECUTION_TIMEOUT_MS,
};
