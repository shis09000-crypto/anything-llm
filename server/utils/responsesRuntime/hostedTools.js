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

function normalizeHostedTool(tool = {}) {
  if (tool?.type === "function" && tool.name) return { ...tool };
  if (tool?.type === "web_search")
    return functionTool(
      "browser_search",
      "Search the public web through Athena Browser/Search governance.",
      {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      }
    );
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
  normalizeHostedTool,
  normalizeHostedTools,
  unsupported,
};
