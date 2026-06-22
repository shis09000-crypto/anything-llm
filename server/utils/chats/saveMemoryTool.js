const { v4: uuidv4 } = require("uuid");
const {
  UserMemory,
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_LABELS,
} = require("../../models/userMemory");

const SAVE_MEMORY_TOOL_NAME = "save_memory";
const EXPLICIT_MEMORY_SOURCE = "explicit_user_request";
const EXPLICIT_MEMORY_CONFIDENCE = "1.0";

const SAVE_MEMORY_TOOL = {
  type: "function",
  function: {
    name: SAVE_MEMORY_TOOL_NAME,
    description:
      "Save a long-term memory only when the user explicitly asks you to remember something for the future.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        category: {
          type: "string",
          enum: MEMORY_CATEGORIES,
          description:
            "One of the six fixed memory modules: preferences, projects, facts, decisions, open_topics, interests.",
        },
        title: {
          type: "string",
          description: "A short second-level memory title.",
        },
        detail: {
          type: "string",
          description: "The exact long-term memory content to save.",
        },
        source: {
          type: "string",
          description:
            "Always use explicit_user_request for this tool unless the server overrides it.",
        },
        confidence: {
          type: "number",
          description: "Always use 1.0 for explicit user memory requests.",
        },
        isSensitive: {
          type: "boolean",
          description:
            "True only when the memory contains private or sensitive information.",
        },
      },
      required: ["category", "title", "detail", "isSensitive"],
    },
  },
};

const SAVE_MEMORY_TOOL_SYSTEM_INSTRUCTION = [
  "The current user message may contain an explicit request to save long-term memory.",
  `If and only if the user explicitly asks to remember something, call ${SAVE_MEMORY_TOOL_NAME}.`,
  "Do not call this tool for ordinary preferences, casual statements, or inferred facts.",
  "Choose exactly one category from the tool enum.",
  "Use source explicit_user_request and confidence 1.0.",
  "Do not mention hidden implementation details.",
].join("\n");

const EXPLICIT_MEMORY_PATTERNS = [
  /记住/,
  /长期记住/,
  /写进记忆/,
  /存进记忆/,
  /加入记忆/,
  /保存到记忆/,
  /以后都要/,
  /以后始终/,
  /以后请/,
  /以后回答都/,
  /\bremember\b/i,
  /\bsave (this|that|it).{0,20}\bmemory\b/i,
  /\bwrite (this|that|it).{0,20}\bmemory\b/i,
];

function hasExplicitMemoryIntent(message = "") {
  const text = String(message || "");
  return EXPLICIT_MEMORY_PATTERNS.some((pattern) => pattern.test(text));
}

function saveMemoryToolsForMessage(message = "") {
  return hasExplicitMemoryIntent(message) ? [SAVE_MEMORY_TOOL] : [];
}

function parseToolArguments(args = {}) {
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      throw new Error("Invalid save_memory arguments JSON.");
    }
  }
  return args && typeof args === "object" ? args : {};
}

function normalizeSaveMemoryArgs(args = {}) {
  const parsed = parseToolArguments(args);
  return {
    category: parsed.category,
    title: String(parsed.title || "").trim(),
    detail: String(parsed.detail || "").trim(),
    source: EXPLICIT_MEMORY_SOURCE,
    confidence: EXPLICIT_MEMORY_CONFIDENCE,
    isSensitive: Boolean(parsed.isSensitive),
  };
}

function approvalPayloadForMemory(input = {}) {
  return {
    category: input.category,
    categoryLabel: MEMORY_CATEGORY_LABELS[input.category] || input.category,
    title: input.title,
    detail: input.detail,
    source: EXPLICIT_MEMORY_SOURCE,
    confidence: Number(EXPLICIT_MEMORY_CONFIDENCE),
    isSensitive: Boolean(input.isSensitive),
  };
}

function saveMemoryToolCallFrom(toolCalls = []) {
  if (!Array.isArray(toolCalls)) return null;
  return toolCalls.find(
    (call) =>
      call?.function?.name === SAVE_MEMORY_TOOL_NAME ||
      call?.name === SAVE_MEMORY_TOOL_NAME
  );
}

async function executeSaveMemoryTool({ memoryOwnerId, userMessage, args }) {
  if (!Number(memoryOwnerId)) throw new Error("Invalid memory owner id.");
  if (!hasExplicitMemoryIntent(userMessage)) {
    throw new Error("save_memory requires an explicit user memory request.");
  }

  const input = normalizeSaveMemoryArgs(args);
  const result = await UserMemory.saveActiveMemory(memoryOwnerId, input);
  return {
    success: true,
    id: result.memory.id,
    category: result.memory.category,
    title: input.title,
    detail: input.isSensitive ? UserMemory.maskedText : input.detail,
    source: result.memory.source,
    confidence: Number(EXPLICIT_MEMORY_CONFIDENCE),
    isSensitive: input.isSensitive,
    created: result.created,
    replaced: result.replaced,
  };
}

function toolCallEventFrom(call = {}, args = {}) {
  return {
    type: "toolCallInvocation",
    uuid: call.id || `tool_call:${uuidv4()}`,
    toolName: SAVE_MEMORY_TOOL_NAME,
    arguments: approvalPayloadForMemory(args),
    content: `Calling ${SAVE_MEMORY_TOOL_NAME}...`,
  };
}

module.exports = {
  SAVE_MEMORY_TOOL_NAME,
  SAVE_MEMORY_TOOL,
  SAVE_MEMORY_TOOL_SYSTEM_INSTRUCTION,
  approvalPayloadForMemory,
  executeSaveMemoryTool,
  hasExplicitMemoryIntent,
  normalizeSaveMemoryArgs,
  saveMemoryToolCallFrom,
  saveMemoryToolsForMessage,
  toolCallEventFrom,
};
