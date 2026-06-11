const { v4: uuidv4 } = require("uuid");
const { WorkspaceChats } = require("../../models/workspaceChats");
const { resetMemory } = require("./commands/reset");
const { convertToPromptHistory } = require("../helpers/chat/responses");
const { SlashCommandPresets } = require("../../models/slashCommandsPresets");
const { SystemPromptVariables } = require("../../models/systemPromptVariables");

const CACHE_STABLE_HISTORY_STRATEGY = "cache-stable-blocks";

const VALID_COMMANDS = {
  "/reset": resetMemory,
};

async function grepCommand(message, user = null) {
  const userPresets = await SlashCommandPresets.getUserPresets(user?.id);
  const availableCommands = Object.keys(VALID_COMMANDS);

  // Check if the message starts with any built-in command
  for (let i = 0; i < availableCommands.length; i++) {
    const cmd = availableCommands[i];
    const re = new RegExp(`^(${cmd})`, "i");
    if (re.test(message)) {
      return cmd;
    }
  }

  // Replace all preset commands with their corresponding prompts
  // Allows multiple commands in one message
  let updatedMessage = message;
  for (const preset of userPresets) {
    const regex = new RegExp(
      `(?:\\b\\s|^)(${preset.command})(?:\\b\\s|$)`,
      "g"
    );
    updatedMessage = updatedMessage.replace(regex, preset.prompt);
  }

  return updatedMessage;
}

/**
 * @description This function will do recursive replacement of all slash commands with their corresponding prompts.
 * @notice This function is used for API calls and is not user-scoped. THIS FUNCTION DOES NOT SUPPORT PRESET COMMANDS.
 * @returns {Promise<string>}
 */
async function grepAllSlashCommands(message) {
  const allPresets = await SlashCommandPresets.where({});

  // Replace all preset commands with their corresponding prompts
  // Allows multiple commands in one message
  let updatedMessage = message;
  for (const preset of allPresets) {
    const regex = new RegExp(
      `(?:\\b\\s|^)(${preset.command})(?:\\b\\s|$)`,
      "g"
    );
    updatedMessage = updatedMessage.replace(regex, preset.prompt);
  }

  return updatedMessage;
}

async function recentChatHistory({
  user = null,
  workspace,
  thread = null,
  messageLimit = 20,
  apiSessionId = null,
  afterChatId = null,
  historyStrategy = null,
}) {
  const clause = {
    workspaceId: workspace.id,
    user_id: user?.id || null,
    thread_id: thread?.id || null,
    api_session_id: apiSessionId || null,
    include: true,
  };
  if (afterChatId !== null) clause.id = { gt: Number(afterChatId) };

  if (historyStrategy?.type === CACHE_STABLE_HISTORY_STRATEGY) {
    const totalCount = await WorkspaceChats.count(clause);
    const historyWindow = cacheStableHistoryWindow({
      totalCount,
      blockSize: historyStrategy.blockSize || messageLimit,
      maxBlocks: historyStrategy.maxBlocks || 2,
    });
    const rawHistory =
      historyWindow.limit > 0
        ? await WorkspaceChats.where(
            clause,
            historyWindow.limit,
            { id: "asc" },
            historyWindow.offset
          )
        : [];

    return {
      rawHistory,
      chatHistory: convertToPromptHistory(rawHistory),
      historyWindow,
    };
  }

  const rawHistory = (
    await WorkspaceChats.where(clause, messageLimit, { id: "desc" })
  ).reverse();
  return { rawHistory, chatHistory: convertToPromptHistory(rawHistory) };
}

function cacheStableHistoryStrategyFor({ llm = null, messageLimit = 20 } = {}) {
  if (!llm?.cacheStableHistory) return null;
  const blockSize = Math.max(1, Number(messageLimit || 20));
  return {
    type: CACHE_STABLE_HISTORY_STRATEGY,
    blockSize,
    maxBlocks: 2,
  };
}

function cacheStableHistoryWindow({
  totalCount = 0,
  blockSize = 20,
  maxBlocks = 2,
} = {}) {
  const normalizedCount = Math.max(0, Number(totalCount || 0));
  const normalizedBlockSize = Math.max(1, Number(blockSize || 20));
  const normalizedMaxBlocks = Math.max(1, Number(maxBlocks || 2));

  if (normalizedCount === 0) {
    return {
      strategy: CACHE_STABLE_HISTORY_STRATEGY,
      totalCount: 0,
      blockSize: normalizedBlockSize,
      maxBlocks: normalizedMaxBlocks,
      offset: 0,
      limit: 0,
      windowStartOrdinal: null,
      windowEndOrdinal: null,
      currentBlockIndex: null,
      historyPressureLimit: normalizedBlockSize * normalizedMaxBlocks,
    };
  }

  const currentBlockIndex = Math.floor(
    (normalizedCount - 1) / normalizedBlockSize
  );
  const firstBlockIndex = Math.max(
    0,
    currentBlockIndex - (normalizedMaxBlocks - 1)
  );
  const offset = firstBlockIndex * normalizedBlockSize;
  const limit = normalizedCount - offset;

  return {
    strategy: CACHE_STABLE_HISTORY_STRATEGY,
    totalCount: normalizedCount,
    blockSize: normalizedBlockSize,
    maxBlocks: normalizedMaxBlocks,
    offset,
    limit,
    windowStartOrdinal: offset + 1,
    windowEndOrdinal: normalizedCount,
    currentBlockIndex,
    historyPressureLimit: normalizedBlockSize * normalizedMaxBlocks,
  };
}

/**
 * Returns the base prompt for the chat. This method will also do variable
 * substitution on the prompt if there are any defined variables in the prompt.
 * @param {Object|null} workspace - the workspace object
 * @param {Object|null} user - the user object
 * @returns {Promise<string>} - the base prompt
 */
async function chatPrompt(workspace, user = null) {
  const { SystemSettings } = require("../../models/systemSettings");
  const basePrompt =
    workspace?.openAiPrompt ?? SystemSettings.saneDefaultSystemPrompt;
  return await SystemPromptVariables.expandSystemPromptVariables(
    basePrompt,
    user?.id,
    workspace?.id
  );
}

// We use this util function to deduplicate sources from similarity searching
// if the document is already pinned.
// Eg: You pin a csv, if we RAG + full-text that you will get the same data
// points both in the full-text and possibly from RAG - result in bad results
// even if the LLM was not even going to hallucinate.
function sourceIdentifier(sourceDocument) {
  if (!sourceDocument?.title || !sourceDocument?.published) return uuidv4();
  return `title:${sourceDocument.title}-timestamp:${sourceDocument.published}`;
}

module.exports = {
  sourceIdentifier,
  recentChatHistory,
  cacheStableHistoryStrategyFor,
  cacheStableHistoryWindow,
  CACHE_STABLE_HISTORY_STRATEGY,
  chatPrompt,
  grepCommand,
  grepAllSlashCommands,
  VALID_COMMANDS,
};
