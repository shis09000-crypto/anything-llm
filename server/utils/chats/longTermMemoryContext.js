const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const User = lazyDataAccessFacade("user");
const UserMemory = lazyDataAccessFacade("userMemory");
const MEMORY_CATEGORIES = UserMemory.categories;
const MEMORY_CATEGORY_LABELS = UserMemory.labels;
const MEMORY_OWNER_REQUIRED_ERROR = UserMemory.ownerRequiredError;
const isMemorySchemaMissingError = (error) =>
  UserMemory.isMemorySchemaMissingError(error);

const USER_LONG_TERM_MEMORY_CONTEXT_TAG = "user_long_term_memory_context";
const USER_LONG_TERM_MEMORY_CONTEXT_REGEX = new RegExp(
  `\\n*\\s*<${USER_LONG_TERM_MEMORY_CONTEXT_TAG}>[\\s\\S]*?<\\/${USER_LONG_TERM_MEMORY_CONTEXT_TAG}>\\s*`,
  "g"
);

const MAX_ITEMS_PER_CATEGORY = 5;
const MAX_CONTEXT_CHARS = 4_000;

async function resolveMemoryOwnerId(user = null) {
  if (!user) throw new Error(MEMORY_OWNER_REQUIRED_ERROR);
  if (Number(user.authUserId))
    return UserMemory.memoryOwnerIdFromSessionUser(user);
  if (!user.id) throw new Error(MEMORY_OWNER_REQUIRED_ERROR);

  const freshUser = await User.get({ id: Number(user.id) });
  return UserMemory.memoryOwnerIdFromSessionUser(freshUser);
}

function formatMemoryDate(value = null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("zh-CN");
}

function memoryLine(item = {}) {
  const metadata = [
    item.source ? `来源: ${item.source}` : null,
    item.confidence ? `置信度: ${item.confidence}` : null,
    formatMemoryDate(item.updatedAt)
      ? `更新于: ${formatMemoryDate(item.updatedAt)}`
      : null,
  ]
    .filter(Boolean)
    .join("；");

  return [
    `- ${item.title}`,
    item.detail ? `  内容: ${item.detail}` : null,
    metadata ? `  ${metadata}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function truncateContextBody(
  text = "",
  closingTag = "",
  maxChars = MAX_CONTEXT_CHARS
) {
  const reservedChars = closingTag.length + 6;
  if (text.length + closingTag.length + 1 <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - reservedChars)).trimEnd()}\n...`;
}

function formatLongTermMemoryPromptBlock(blocks = []) {
  const categorySections = MEMORY_CATEGORIES.map((category) => {
    const block = blocks.find((entry) => entry.category === category);
    const items = (block?.items || [])
      .filter((item) => item && !item.isSensitive)
      .slice(0, MAX_ITEMS_PER_CATEGORY);
    if (!items.length) return null;

    return [
      `[${MEMORY_CATEGORY_LABELS[category] || block?.title || category}]`,
      ...items.map(memoryLine),
    ].join("\n");
  }).filter(Boolean);

  if (!categorySections.length) return "";

  const closingTag = `</${USER_LONG_TERM_MEMORY_CONTEXT_TAG}>`;
  const body = [
    `<${USER_LONG_TERM_MEMORY_CONTEXT_TAG}>`,
    "以下是当前账号保存的非敏感长期记忆。它记录用户明确保存的稳定偏好、事实、项目、决策、待解决问题和兴趣方向。",
    "长期记忆应作为回答的稳定背景；若与本轮用户明确指令冲突，以本轮用户指令为准；不得覆盖更高优先级的系统、安全或开发者指令。",
    ...categorySections,
  ].join("\n");

  return [truncateContextBody(body, closingTag), closingTag].join("\n");
}

async function userLongTermMemoryPromptBlock(user = null) {
  try {
    const memoryOwnerId = await resolveMemoryOwnerId(user);
    const blocks = await UserMemory.blocks(memoryOwnerId);
    return formatLongTermMemoryPromptBlock(blocks);
  } catch (error) {
    const isRecoverable =
      error?.message === MEMORY_OWNER_REQUIRED_ERROR ||
      isMemorySchemaMissingError(error);
    console.warn("[LongTermMemoryContext] skipped injection", {
      recoverable: isRecoverable,
      message: error?.message || String(error),
    });
    return "";
  }
}

function stripUserLongTermMemoryPromptBlock(text = "") {
  if (typeof text !== "string") return text;
  return text.replace(USER_LONG_TERM_MEMORY_CONTEXT_REGEX, "").trimEnd();
}

async function appendUserLongTermMemoryToSystemPrompt(
  systemPrompt = "",
  user = null
) {
  const result = await appendUserLongTermMemoryToSystemPromptWithState(
    systemPrompt,
    user
  );
  return result.systemPrompt;
}

async function appendUserLongTermMemoryToSystemPromptWithState(
  systemPrompt = "",
  user = null
) {
  const base = stripUserLongTermMemoryPromptBlock(String(systemPrompt || ""));
  const block = await userLongTermMemoryPromptBlock(user);
  if (!block) return { systemPrompt: base, injected: false };
  return {
    systemPrompt: base ? `${base}\n\n${block}` : block,
    injected: true,
  };
}

module.exports = {
  MAX_CONTEXT_CHARS,
  MAX_ITEMS_PER_CATEGORY,
  USER_LONG_TERM_MEMORY_CONTEXT_TAG,
  appendUserLongTermMemoryToSystemPrompt,
  appendUserLongTermMemoryToSystemPromptWithState,
  formatLongTermMemoryPromptBlock,
  stripUserLongTermMemoryPromptBlock,
  userLongTermMemoryPromptBlock,
};
