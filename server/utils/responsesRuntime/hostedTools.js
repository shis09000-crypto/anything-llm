function unsupported() {
  const error = new Error("hosted_tool_not_supported");
  error.code = "hosted_tool_not_supported";
  error.httpStatus = 400;
  return error;
}

function functionTool(name, description, parameters) {
  return {
    type: "function",
    name,
    description,
    parameters,
    strict: false,
  };
}

const RESPONSES_WEB_SEARCH_TYPES = new Set([
  "web_search",
  "web_search_2025_08_26",
]);

function nativeWebSearchTool(tool = {}) {
  const type = RESPONSES_WEB_SEARCH_TYPES.has(tool?.type)
    ? tool.type
    : "web_search";
  return { type };
}

function withNativeWebSearch(tools = []) {
  const normalized = Array.isArray(tools) ? [...tools] : [];
  const existingIndex = normalized.findIndex((tool) =>
    RESPONSES_WEB_SEARCH_TYPES.has(tool?.type)
  );
  if (existingIndex === 0) return normalized;
  if (existingIndex > 0) {
    const [existing] = normalized.splice(existingIndex, 1);
    return [existing, ...normalized];
  }
  return [nativeWebSearchTool(), ...normalized];
}

function normalizeHostedTool(tool = {}) {
  if (tool?.type === "function" && tool.name) return { ...tool };
  if (RESPONSES_WEB_SEARCH_TYPES.has(tool?.type))
    return nativeWebSearchTool(tool);
  if (tool?.type === "file_search")
    return functionTool(
      "get_workspace_supplement",
      "Read workspace-scoped Knowledge material through Athena RAG governance.",
      {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["kind", "document"] },
          supplementKind: { type: "string" },
          supplementId: { type: "number" },
          query: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 3 },
        },
        required: ["mode"],
        additionalProperties: false,
      }
    );
  if (["computer", "computer_use", "browser"].includes(tool?.type))
    return functionTool(
      "browser_interact",
      "Perform a Browser Plane action under Athena approval policy.",
      {
        type: "object",
        properties: {
          action: { type: "string" },
          arguments: { type: "object" },
        },
        required: ["action"],
        additionalProperties: false,
      }
    );
  if (tool?.type === "mcp" && tool.name)
    return functionTool(
      tool.name,
      tool.description || "Invoke an Athena-governed MCP tool.",
      tool.parameters || { type: "object", properties: {} }
    );
  throw unsupported();
}

function normalizeHostedTools(tools = []) {
  return tools.map(normalizeHostedTool);
}

module.exports = {
  RESPONSES_WEB_SEARCH_TYPES,
  nativeWebSearchTool,
  normalizeHostedTool,
  normalizeHostedTools,
  unsupported,
  withNativeWebSearch,
};
