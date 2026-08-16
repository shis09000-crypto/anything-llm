/* eslint-disable unused-imports/no-unused-vars */
const { EventEmitter } = require("events");
const { APIError } = require("./error.js");
const { createAgentProvider } = require("./providers/factory.js");
const {
  TelemetryRepository: Telemetry,
} = require("../../../repositories/telemetryRepository");
const { v4 } = require("uuid");
const { ToolReranker } = require("./utils/toolReranker.js");
const {
  storeToolRun,
  prepareToolResultForModel,
} = require("../toolResultStore.js");
const {
  appendCurrentDateTimeToLastUserMessage,
} = require("../../chats/currentDateTimeContext.js");
const {
  appendUserPersonalizationToSystemPrompt,
} = require("../../chats/personalizationContext.js");
const {
  appendUserLongTermMemoryToSystemPrompt,
} = require("../../chats/longTermMemoryContext.js");
const { toolExecutionTimeoutMs } = require("./toolTimeouts.js");
const api = require("@opentelemetry/api");
const {
  runWithOperationContext,
  withOperationSpan,
  correlationCoverage,
  currentOperationContext,
} = require("../../observability/operationContext.js");
const { emitSemanticEvent } = require("../../observability/semanticEvents.js");
const { metrics } = require("../../observability/metrics.js");
const { resolveTaskProviderModel } = require("../../llmTasks");
const {
  REQUEST_USER_INPUT_TOOL_NAME,
} = require("./plugins/request-user-input.js");

function shouldForwardProviderStreamEvent(type, data) {
  if (type !== "reportStreamEvent") return true;
  if (data?.type !== "toolCallInvocation") return true;
  return data?.phase === "ready" && Boolean(data?.toolName);
}

function readyToolInvocationEvent(functionCall, depth, fallbackUuid) {
  const name = String(functionCall?.name || "").trim();
  if (!name) return null;
  const callId =
    functionCall?.id || functionCall?.call_id || `${fallbackUuid}:${depth}`;
  return {
    type: "toolCallInvocation",
    uuid: `tool_call:${callId}`,
    toolName: name,
    phase: "ready",
    content: `Calling ${name}.`,
  };
}

function continuationProviderConfigForFunction(fn = {}) {
  const taskName = String(fn?.continuationTask || "").trim();
  if (!taskName) return null;
  return {
    taskName,
    ...resolveTaskProviderModel(taskName),
  };
}

/**
 * AIbitat is a class that manages the conversation between agents.
 * It is designed to solve a task with LLM.
 *
 * Guiding the chat through a graph of agents.
 */
class AIbitat {
  emitter = new EventEmitter();

  /**
   * Temporary flag to skip the handleExecution function
   * This is used to return the result of a flow execution directly to the chat
   * without going through the handleExecution function (resulting in more LLM processing)
   *
   * Setting Skip execution to true will prevent any further tool calls from being executed.
   * This is useful for flow executions that need to return a result directly to the chat but
   * can also prevent tool-call chaining.
   *
   * @type {boolean}
   */
  skipHandleExecution = false;

  provider = null;
  defaultProvider = null;
  defaultInterrupt;
  maxRounds;
  _chats;
  _trackedChatId = null;
  _trackedPublicChatId = null;
  agents = new Map();
  channels = new Map();
  functions = new Map();

  /**
   * Buffer for citations collected during tool execution.
   * Citations are flushed to the frontend when the response is finalized.
   * @type {Array<{id: string, title: string, text: string, chunkSource?: string, score?: number}>}
   */
  _pendingCitations = [];

  /**
   * Buffer for attachments (images) collected during tool execution.
   * Tools can call addToolAttachment() to queue images for injection into the conversation.
   * These are injected as a user message so all providers' existing attachment handling works.
   * @type {Array<{name: string, mime: string, contentString: string}>}
   */
  _toolAttachments = [];

  /**
   * Buffer for clarifying-question surveys completed during tool execution.
   * The chat-history plugin drains this buffer into workspace_chats.response.
   * @type {Array<{questions: Array<Object>, result: Object}>}
   */
  _pendingClarifyingQuestionSurveys = [];

  /**
   * Transient prompt-tail blocks for the current provider continuation.
   * These are appended after tool results so clarification answers sit at
   * the end of the dynamic prompt instead of changing stable prompt prefixes.
   * @type {string[]}
   */
  _pendingClarifyingQuestionPromptTails = [];

  /**
   * Get the default maximum number of tools an agent can chain for a single response.
   * @returns {number}
   */
  static defaultMaxToolCalls() {
    const envMaxToolCalls = parseInt(process.env.AGENT_MAX_TOOL_CALLS, 10);
    return !isNaN(envMaxToolCalls) && envMaxToolCalls > 0
      ? envMaxToolCalls
      : 10;
  }

  /**
   * Create a new AIbitat instance.
   * @param {Object} props - The properties for the AIbitat instance.
   * @param {Array} props.chats - [default: []] The chat history between agents and channels.
   * @param {string} props.interrupt - [default: "NEVER"] The interrupt mode for the AIbitat instance.
   * @param {number} props.maxRounds - [default: 100] The maximum number of rounds for the AIbitat instance.
   * @param {number} props.maxToolCalls - [default: AIbitat.defaultMaxToolCalls()] The maximum number of tools an agent can chain for a single response.
   * @param {string} props.provider - [default: "openai"] The provider for the AIbitat instance.
   * @param {Object} props.handlerProps - The handler properties for the AIbitat instance.
   * @param {Object} rest - The rest of the properties for the AIbitat instance.
   */
  constructor(props = {}) {
    const {
      chats = [],
      interrupt = "NEVER",
      maxRounds = 100,
      maxToolCalls = AIbitat.defaultMaxToolCalls(),
      provider = "openai",
      handlerProps = {}, // Inherited props we can spread so aibitat can access.
      ...rest
    } = props;
    this._chats = chats;
    this.defaultInterrupt = interrupt;
    this.maxRounds = maxRounds;
    this.maxToolCalls = maxToolCalls;
    this.handlerProps = handlerProps;

    this.defaultProvider = {
      provider,
      ...rest,
    };
    this.provider = this.defaultProvider.provider;
    this.model = this.defaultProvider.model;
  }

  /**
   * Get the chat history between agents and channels.
   */
  get chats() {
    return this._chats;
  }

  /**
   * Install a plugin.
   */
  use(plugin) {
    plugin.setup(this);
    return this;
  }

  /**
   * Register a new chat ID for tracking for a given conversation exchange
   * @param {number} chatId - The ID of the chat to register.
   */
  registerChatId(chatId = null, publicChatId = null) {
    if (!chatId) return;
    this._trackedChatId = chatId;
    this._trackedPublicChatId = publicChatId || this._trackedPublicChatId;
  }

  /**
   * Get the tracked chat ID for a given conversation exchange
   * @returns {number|null} The ID of the chat to register.
   */
  get trackedChatId() {
    return this._trackedChatId ?? null;
  }

  get trackedPublicChatId() {
    return this._trackedPublicChatId ?? null;
  }

  /**
   * Clear the tracked chat ID for a given conversation exchange
   */
  clearTrackedChatId() {
    this._trackedChatId = null;
    this._trackedPublicChatId = null;
  }

  /**
   * Emit the tracked chat ID to the frontend via the websocket
   * plugin (assumed to be attached).
   * @param {string} [uuid] - The message UUID to associate with this chatId
   */
  emitChatId(uuid = null) {
    if (!Number.isSafeInteger(Number(this.trackedChatId)) || !uuid) return null;
    this.socket?.send?.("reportStreamEvent", {
      type: "chatId",
      uuid,
      chatId: this.trackedChatId,
      publicChatId: this.trackedPublicChatId,
      clientTurnId: this.handlerProps?.invocation?.clientTurnId || null,
    });
  }

  /**
   * Emit the canonical Responses API terminal event after all answer, usage,
   * citation, and persistence patches for the current turn have been sent.
   * The Agent websocket may remain reusable, but this response turn is done.
   */
  emitResponseCompleted(uuid = null, usage = {}) {
    if (!uuid) return null;
    const completedAt = Math.floor(Date.now() / 1000);
    this.socket?.send?.("response.completed", {
      response: {
        id: uuid,
        object: "response",
        status: "completed",
        completed_at: completedAt,
        error: null,
        incomplete_details: null,
        output: [],
        usage: usage || {},
        metadata: {
          clientTurnId: this.handlerProps?.invocation?.clientTurnId || null,
          chatId: this.trackedChatId,
          publicChatId: this.trackedPublicChatId,
        },
      },
    });
  }

  stageResponseCompletion(uuid = null, usage = {}) {
    if (!uuid) return null;
    this._pendingResponseCompletion = { uuid, usage: usage || {} };
  }

  async finalizeResponseTurn() {
    const pending = this._pendingResponseCompletion;
    if (!pending?.uuid) return null;
    if (typeof this.persistCompletedTurn !== "function")
      throw new Error("agent_final_persistence_unavailable");
    const persistedChatId = await this.persistCompletedTurn();
    if (!persistedChatId || !this.trackedChatId)
      throw new Error("agent_final_chat_persistence_failed");
    this.emitChatId(pending.uuid);
    this.emitResponseCompleted(pending.uuid, pending.usage);
    this._pendingResponseCompletion = null;
    this.cleanupCompletedTurn?.();
    return pending.uuid;
  }

  /**
   * Add citation(s) to be reported when the response is finalized.
   * Citations are buffered and flushed with the correct message UUID.
   * @param {{id: string, title: string, text: string, chunkSource?: string, score?: number}|Array<{id: string, title: string, text: string, chunkSource?: string, score?: number}>} citations - Citation object or array of citation objects
   */
  addCitation(citations) {
    if (!citations) return;
    if (Array.isArray(citations))
      this._pendingCitations.push(...citations.filter(Boolean));
    else if (typeof citations === "object")
      this._pendingCitations.push(citations);
  }

  /**
   * Flush all pending citations to the frontend with the given message UUID.
   * Called automatically when the agent response is finalized.
   * Note: Does not clear citations - they are cleared by chat-history plugin after persisting.
   * @param {string} messageUuid - The UUID of the message to attach citations to
   */
  flushCitations(messageUuid) {
    if (!messageUuid || this._pendingCitations.length === 0) return;
    this.socket?.send?.("reportStreamEvent", {
      type: "citations",
      uuid: messageUuid,
      citations: this._pendingCitations,
    });
  }

  /**
   * Clear all pending citations. Called after citations have been persisted.
   */
  clearCitations() {
    this._pendingCitations = [];
  }

  /**
   * Add an attachment (image) from a tool to be injected into the conversation.
   * The attachment will be added as a user message so the model can "see" it.
   * This leverages existing provider attachment handling for user messages.
   * @param {{name: string, mime: string, contentString: string}} attachment - The attachment object with name, mime type, and base64 data URL
   */
  addToolAttachment(attachment) {
    if (!attachment || !attachment.contentString) return;
    this._toolAttachments.push(attachment);
  }

  /**
   * Add a completed clarifying-question survey to the pending persistence buffer.
   * @param {{questions: Array<Object>, result: Object}} survey - The survey to add
   */
  addClarifyingQuestionSurvey(survey) {
    if (!survey || typeof survey !== "object") return;
    this._pendingClarifyingQuestionSurveys.push(survey);
  }

  /**
   * Add a dynamic prompt-tail block for the current continuation.
   * @param {string} block
   */
  addClarifyingQuestionPromptTail(block = "") {
    if (!block || typeof block !== "string") return;
    this._pendingClarifyingQuestionPromptTails.push(block);
  }

  /**
   * Collect and clear pending clarification prompt-tail blocks.
   * @returns {string}
   */
  collectClarifyingQuestionPromptTail() {
    if (this._pendingClarifyingQuestionPromptTails.length === 0) return "";
    const block = this._pendingClarifyingQuestionPromptTails
      .filter(Boolean)
      .join("\n\n");
    this._pendingClarifyingQuestionPromptTails = [];
    return block;
  }

  /**
   * Clear all pending clarifying-question surveys.
   */
  clearClarifyingQuestionSurveys() {
    this._pendingClarifyingQuestionSurveys = [];
    this._pendingClarifyingQuestionPromptTails = [];
  }

  /**
   * Collect and clear any pending tool attachments.
   * @returns {Array<{name: string, mime: string, contentString: string}>} The collected attachments
   */
  collectToolAttachments() {
    if (this._toolAttachments.length === 0) return [];
    const attachments = [...this._toolAttachments];
    this._toolAttachments = [];
    return attachments;
  }

  /**
   * Add a new agent to the AIbitat.
   *
   * @param name
   * @param config
   * @returns
   */
  agent(name = "", config = {}) {
    this.agents.set(name, config);
    return this;
  }

  /**
   * Add a new channel to the AIbitat.
   *
   * @param name
   * @param members
   * @param config
   * @returns
   */
  channel(name = "", members = [""], config = {}) {
    this.channels.set(name, {
      members,
      ...config,
    });
    return this;
  }

  /**
   * Get the specific agent configuration.
   *
   * @param agent The name of the agent.
   * @throws When the agent configuration is not found.
   * @returns The agent configuration.
   */
  getAgentConfig(agent = "") {
    const config = this.agents.get(agent);
    if (!config) {
      throw new Error(`Agent configuration "${agent}" not found`);
    }
    return {
      role: "You are a helpful AI assistant.",
      //       role: `You are a helpful AI assistant.
      // Solve tasks using your coding and language skills.
      // In the following cases, suggest typescript code (in a typescript coding block) or shell script (in a sh coding block) for the user to execute.
      //     1. When you need to collect info, use the code to output the info you need, for example, browse or search the web, download/read a file, print the content of a webpage or a file, get the current date/time, check the operating system. After sufficient info is printed and the task is ready to be solved based on your language skill, you can solve the task by yourself.
      //     2. When you need to perform some task with code, use the code to perform the task and output the result. Finish the task smartly.
      // Solve the task step by step if you need to. If a plan is not provided, explain your plan first. Be clear which step uses code, and which step uses your language skill.
      // When using code, you must indicate the script type in the code block. The user cannot provide any other feedback or perform any other action beyond executing the code you suggest. The user can't modify your code. So do not suggest incomplete code which requires users to modify. Don't use a code block if it's not intended to be executed by the user.
      // If you want the user to save the code in a file before executing it, put # filename: <filename> inside the code block as the first line. Don't include multiple code blocks in one response. Do not ask users to copy and paste the result. Instead, use 'print' function for the output when relevant. Check the execution result returned by the user.
      // If the result indicates there is an error, fix the error and output the code again. Suggest the full code instead of partial code or code changes. If the error can't be fixed or if the task is not solved even after the code is executed successfully, analyze the problem, revisit your assumption, collect additional info you need, and think of a different approach to try.
      // When you find an answer, verify the answer carefully. Include verifiable evidence in your response if possible.
      // Reply "TERMINATE" when everything is done.`,
      ...config,
    };
  }

  /**
   * Get the specific channel configuration.
   *
   * @param channel The name of the channel.
   * @throws When the channel configuration is not found.
   * @returns The channel configuration.
   */
  getChannelConfig(channel = "") {
    const config = this.channels.get(channel);
    if (!config) {
      throw new Error(`Channel configuration "${channel}" not found`);
    }
    return {
      maxRounds: 10,
      role: "",
      ...config,
    };
  }

  /**
   * Get the members of a group.
   * @throws When the group is not defined as an array in the connections.
   * @param node The name of the group.
   * @returns The members of the group.
   */
  getGroupMembers(node = "") {
    const group = this.getChannelConfig(node);
    return group.members;
  }

  /**
   * Triggered when a plugin, socket, or command is aborted.
   *
   * @param listener
   * @returns
   */
  onAbort(listener = () => null) {
    this.emitter.on("abort", listener);
    return this;
  }

  /**
   * Abort the running of any plugins that may still be pending (Langchain summarize)
   */
  abort() {
    this.emitter.emit("abort", null, this);
  }

  /**
   * Triggered when a chat is terminated. After this, the chat can't be continued.
   *
   * @param listener
   * @returns
   */
  onTerminate(listener = () => null) {
    this.emitter.on("terminate", listener);
    return this;
  }

  /**
   * Terminate the chat. After this, the chat can't be continued.
   *
   * @param node Last node to chat with
   */
  terminate(node = "") {
    this.emitter.emit("terminate", node, this);
  }

  /**
   * Triggered when a chat is interrupted by a node.
   *
   * @param listener
   * @returns
   */
  onInterrupt(listener = () => null) {
    this.emitter.on("interrupt", listener);
    return this;
  }

  /**
   * Interruption the chat.
   *
   * @param route The nodes that participated in the interruption.
   * @returns
   */
  interrupt(route) {
    this._chats.push({
      ...route,
      state: "interrupt",
    });
    this.emitter.emit("interrupt", route, this);
  }

  /**
   * Triggered when a message is added to the chat history.
   * This can either be the first message or a reply to a message.
   *
   * @param listener
   * @returns
   */
  onMessage(listener = (chat) => null) {
    this.emitter.on("message", listener);
    return this;
  }

  /**
   * Register a new successful message in the chat history.
   * This will trigger the `onMessage` event.
   *
   * @param message
   */
  newMessage(message) {
    const chat = {
      ...message,
      state: "success",
    };

    this._chats.push(chat);
    this.emitter.emit("message", chat, this);
  }

  /**
   * Triggered when an error occurs during the chat.
   *
   * @param listener
   * @returns
   */
  onError(
    listener = (
      /**
       * The error that occurred.
       *
       * Native errors are:
       * - `APIError`
       * - `AuthorizationError`
       * - `UnknownError`
       * - `RateLimitError`
       * - `ServerError`
       */
      error = null,
      /**
       * The message when the error occurred.
       */
      // eslint-disable-next-line
      {}
    ) => null
  ) {
    this.emitter.on("replyError", listener);
    return this;
  }

  /**
   * Triggered when a tool call completes and returns a result.
   * Used by scheduled jobs to capture tool results for the execution trace.
   *
   * @param listener
   * @returns
   */
  onToolCallResult(listener = () => null) {
    this.emitter.on("toolCallResult", listener);
    return this;
  }

  /**
   * Register an error in the chat history.
   * This will trigger the `onError` event.
   *
   * @param route
   * @param error
   */
  newError(route, error) {
    const chat = {
      ...route,
      content: error instanceof Error ? error.message : String(error),
      state: "error",
    };
    this._chats.push(chat);
    this.emitter.emit("replyError", error, chat);
  }

  /**
   * Triggered when a chat is interrupted by a node.
   *
   * @param listener
   * @returns
   */
  onStart(listener = (chat, aibitat) => null) {
    this.emitter.on("start", listener);
    return this;
  }

  /**
   * Start a new chat.
   *
   * @param message The message to start the chat.
   */
  async start(message) {
    // register the message in the chat history
    this.newMessage(message);

    this.emitter.emit("start", message, this);

    // ask the node to reply
    await this.chat({
      to: message.from,
      from: message.to,
    });

    return this;
  }

  /**
   * Recursively chat between two nodes.
   *
   * @param route
   * @param keepAlive Whether to keep the chat alive.
   */
  async chat(route, keepAlive = true) {
    // check if the message is for a group
    // if it is, select the next node to chat with from the group
    // and then ask them to reply.
    if (this.channels.get(route.from)) {
      // select a node from the group
      let nextNode;
      try {
        nextNode = await this.selectNext(route.from);
      } catch (error) {
        if (error instanceof APIError) {
          return this.newError({ from: route.from, to: route.to }, error);
        }
        throw error;
      }

      if (!nextNode) {
        // TODO: should it throw an error or keep the chat alive when there is no node to chat with in the group?
        // maybe it should wrap up the chat and reply to the original node
        // For now, it will terminate the chat
        this.terminate(route.from);
        return;
      }

      const nextChat = {
        from: nextNode,
        to: route.from,
      };

      if (this.shouldAgentInterrupt(nextNode)) {
        this.interrupt(nextChat);
        return;
      }

      // get chats only from the group's nodes
      const history = this.getHistory({ to: route.from });
      const group = this.getGroupMembers(route.from);
      const rounds = history.filter((chat) => group.includes(chat.from)).length;

      const { maxRounds } = this.getChannelConfig(route.from);
      if (rounds >= maxRounds) {
        this.terminate(route.to);
        return;
      }

      await this.chat(nextChat);
      return;
    }

    // If it's a direct message, reply to the message
    let reply = "";
    try {
      reply = await this.reply(route);
    } catch (error) {
      if (error instanceof APIError) {
        return this.newError({ from: route.from, to: route.to }, error);
      }
      throw error;
    }

    if (
      reply === "TERMINATE" ||
      this.hasReachedMaximumRounds(route.from, route.to)
    ) {
      this.terminate(route.to);
      return;
    }

    const newChat = { to: route.from, from: route.to };

    if (
      reply === "INTERRUPT" ||
      (this.agents.get(route.to) && this.shouldAgentInterrupt(route.to))
    ) {
      this.interrupt(newChat);
      return;
    }

    if (keepAlive) {
      // keep the chat alive by replying to the other node
      await this.chat(newChat, true);
    }
  }

  /**
   * Check if the agent should interrupt the chat based on its configuration.
   *
   * @param agent
   * @returns {boolean} Whether the agent should interrupt the chat.
   */
  shouldAgentInterrupt(agent = "") {
    const config = this.getAgentConfig(agent);
    return this.defaultInterrupt === "ALWAYS" || config.interrupt === "ALWAYS";
  }

  /**
   * Select the next node to chat with from a group. The node will be selected based on the history of chats.
   * It will select the node that has not reached the maximum number of rounds yet and has not chatted with the channel in the last round.
   * If it could not determine the next node, it will return a random node.
   *
   * @param channel The name of the group.
   * @returns The name of the node to chat with.
   */
  async selectNext(channel = "") {
    // get all members of the group
    const nodes = this.getGroupMembers(channel);
    const channelConfig = this.getChannelConfig(channel);

    // TODO: move this to when the group is created
    // warn if the group is underpopulated
    if (nodes.length < 3) {
      console.warn(
        `- Group (${channel}) is underpopulated with ${nodes.length} agents. Direct communication would be more efficient.`
      );
    }

    // get the nodes that have not reached the maximum number of rounds
    const availableNodes = nodes.filter(
      (node) => !this.hasReachedMaximumRounds(channel, node)
    );

    // remove the last node that chatted with the channel, so it doesn't chat again
    const lastChat = this._chats.filter((c) => c.to === channel).at(-1);
    if (lastChat) {
      const index = availableNodes.indexOf(lastChat.from);
      if (index > -1) {
        availableNodes.splice(index, 1);
      }
    }

    // TODO: what should it do when there is no node to chat with?
    if (!availableNodes.length) return;

    // get the provider that will be used for the channel
    // if the channel has a provider, use that otherwise
    // use the GPT-4 because it has a better reasoning
    const provider = this.getProviderForConfig({
      // @ts-expect-error
      model: "gpt-4",
      ...this.defaultProvider,
      ...channelConfig,
    });
    provider.attachHandlerProps(this.handlerProps);

    const history = this.getHistory({ to: channel });

    // build the messages to send to the provider
    const messages = [
      {
        role: "system",
        content: channelConfig.role,
      },
      {
        role: "user",
        content: `You are in a role play game. The following roles are available:
${availableNodes.map((node) => `@${node}: ${this.getAgentConfig(node).role}`).join("\n")}.

Read the following conversation.

CHAT HISTORY
${history.map((c) => `@${c.from}: ${c.content}`).join("\n")}

Then select the next role from that is going to speak next.
Only return the role.
`,
      },
    ];

    // ask the provider to select the next node to chat with
    // and remove the @ from the response
    const { result } = await provider.complete(messages);
    const name = result?.replace(/^@/g, "");
    if (this.agents.get(name)) return name;

    // if the name is not in the nodes, return a random node
    return availableNodes[Math.floor(Math.random() * availableNodes.length)];
  }

  /**
   *
   * @param {string} pluginName this name of the plugin being called
   * @returns string of the plugin to be called compensating for children denoted by # in the string.
   * eg: sql-agent:list-database-connections
   * or is a custom plugin
   * eg: @@custom-plugin-name
   */
  #parseFunctionName(pluginName = "") {
    if (!pluginName.includes("#") && !pluginName.startsWith("@@"))
      return pluginName;
    if (pluginName.startsWith("@@")) return pluginName.replace("@@", "");
    return pluginName.split("#")[1];
  }

  /**
   * Extract the user's prompt from the messages array for tool reranking.
   * Gets the content of the last user message.
   * @param {Array} messages - Array of chat messages
   * @returns {string|null} The user's prompt or null if not found
   */
  #extractUserPrompt(messages) {
    if (!messages || !Array.isArray(messages)) return null;

    // Find the last user message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "user" && msg.content) {
        return typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);
      }
    }
    return null;
  }

  /**
   * Check if the chat has reached the maximum number of rounds.
   */
  hasReachedMaximumRounds(from = "", to = "") {
    return this.getHistory({ from, to }).length >= this.maxRounds;
  }

  /**
   * Get the chat history between two nodes or all chats to/from a node.
   *
   * @param route
   * @returns
   */
  getOrFormatNodeChatHistory(route) {
    if (this.channels.get(route.to)) {
      return [
        {
          role: "user",
          content: `You are in a whatsapp group. Read the following conversation and then reply.
Do not add introduction or conclusion to your reply because this will be a continuous conversation. Don't introduce yourself.

CHAT HISTORY
${this.getHistory({ to: route.to })
  .map((c) => `@${c.from}: ${c.content}`)
  .join("\n")}

@${route.from}:`,
        },
      ];
    }

    // This is normal chat between user<->agent
    // Include attachments if present (for vision/multimodal support)
    return this.getHistory(route).map((c) => {
      const message = {
        content: c.content,
        role: c.from === route.to ? "user" : "assistant",
      };
      // Pass attachments through for user messages that have them
      if (
        c.attachments &&
        c.attachments.length > 0 &&
        message.role === "user"
      ) {
        message.attachments = c.attachments;
      }
      return message;
    });
  }

  /**
   * Ask the for the AI provider to generate a reply to the chat.
   * This will load the functions that the node can call and the chat history.
   * Then before calling the provider, it will check if the provider supports agent streaming.
   * If it does, it will call the provider asynchronously (streaming).
   * Otherwise, it will call the provider synchronously (non-streaming).
   * `.supportsAgentStreaming` is used to determine if the provider supports agent streaming on the respective provider.
   *
   * @param route.to The node that sent the chat.
   * @param route.from The node that will reply to the chat.
   */
  async reply(route) {
    const fromConfig = this.getAgentConfig(route.from);
    const chatHistory = this.getOrFormatNodeChatHistory(route);

    // Fetch fresh parsed file context and inject into the last user message
    if (this.fetchParsedFileContext) {
      const parsedContext = await this.fetchParsedFileContext();
      if (parsedContext) {
        // Find the last user message and append context to it
        for (let i = chatHistory.length - 1; i >= 0; i--) {
          if (chatHistory[i].role === "user") {
            chatHistory[i] = {
              ...chatHistory[i],
              content: chatHistory[i].content + parsedContext,
            };
            break;
          }
        }
      }
    }

    const promptUser = { id: this.handlerProps?.invocation?.user_id };
    let agentSystemPrompt = await appendUserPersonalizationToSystemPrompt(
      fromConfig.role,
      promptUser
    );
    agentSystemPrompt = await appendUserLongTermMemoryToSystemPrompt(
      agentSystemPrompt,
      promptUser
    );
    agentSystemPrompt = [
      agentSystemPrompt,
      this.handlerProps?.compactedThreadMemory,
    ]
      .filter(Boolean)
      .join("\n\n");

    const messages = [
      {
        content: agentSystemPrompt,
        role: "system",
      },
      ...chatHistory,
    ];

    // get the functions that the node can call
    let functions = fromConfig.functions
      ?.map((name) => this.functions.get(this.#parseFunctionName(name)))
      .filter((a) => !!a);

    // Rerank tools based on user prompt if enabled
    if (ToolReranker.isEnabled() && functions?.length) {
      const toolReranker = new ToolReranker();
      const userPrompt = this.#extractUserPrompt(messages);
      if (userPrompt)
        functions = await toolReranker.rerank(userPrompt, functions);
    } else {
      if (functions?.length > ToolReranker.defaultTopN) {
        this.handlerProps.log?.(
          `

\x1b[44m[HINT]\x1b[0m: You are injecting \x1b[0;93m${functions.length} tools\x1b[0m into every request.
Consider enabling \x1b[0;93mIntelligent Skill Selection\x1b[0m to reduce token usage from tool call bloat by up to \x1b[0;93m80% per request\x1b[0m.
https://docs.anythingllm.com/agent/intelligent-tool-selection

`
        );
      }
    }

    const provider = this.getProviderForConfig({
      ...this.defaultProvider,
      ...fromConfig,
    });
    provider.attachHandlerProps(this.handlerProps);

    let content;
    if (provider.supportsAgentStreaming) {
      this.handlerProps.log?.(
        "[DEBUG] Provider supports agent streaming - will use async execution!"
      );
      content = await this.handleAsyncExecution(
        provider,
        messages,
        functions,
        route.from
      );
    } else {
      this.handlerProps.log?.(
        "[DEBUG] Provider does not support agent streaming - will use synchronous execution!"
      );
      content = await this.handleExecution(
        provider,
        messages,
        functions,
        route.from
      );
    }

    // Store the active provider so plugins can access usage metrics
    this.provider = provider;
    this.newMessage({ ...route, content });
    await this.finalizeResponseTurn();
    return content;
  }

  /**
   * Wrapper for provider calls that catches errors and converts them to APIError.
   * This ensures provider errors are properly surfaced to the user instead of crashing.
   *
   * @param {Function} providerCall - Async function that calls the provider
   * @returns {Promise<any>} - The result of the provider call
   * @throws {APIError} - If the provider call fails
   */
  async #safeProviderCall(providerCall, provider = null) {
    const providerName = String(
      provider?.provider || this.provider || "unknown"
    ).slice(0, 64);
    const startedAt = Date.now();
    let outcome = "success";
    return runWithOperationContext(
      {
        invocationId: this.handlerProps?.invocation?.uuid,
        clientTurnId: this.handlerProps?.invocation?.clientTurnId,
        workspaceId: this.handlerProps?.invocation?.workspace_id,
        threadId: this.handlerProps?.invocation?.thread_id,
        journey: "agent_tool",
      },
      async () => {
        try {
          return await withOperationSpan(
            "gen_ai.agent.invoke",
            {
              kind: api.SpanKind.CLIENT,
              attributes: {
                "gen_ai.operation.name": "agent",
                "gen_ai.provider.name": providerName,
                "gen_ai.request.model": String(
                  provider?.model || this.model || "unknown"
                ).slice(0, 128),
              },
            },
            providerCall
          );
        } catch (error) {
          outcome = "failure";
          emitSemanticEvent({
            eventType: "agent.model.failed",
            category: "agent",
            severity: "error",
            outcome,
            subject: {
              type: "agent",
              component: providerName,
              operation: "model_invoke",
            },
            impact: { userEffect: "agent_response_unavailable" },
            evidence: [
              {
                type: "trace",
                ref: currentOperationContext()?.traceId || "unavailable",
              },
            ],
            metadata: {
              errorCode: error?.code || "agent_model_failed",
              provider: providerName,
            },
          });
          console.error(`[AIbitat] Provider error: ${error.message}`, {
            hide_meta: true,
          });
          throw new APIError(
            `The agent model failed to respond: ${error.message}`
          );
        } finally {
          const labels = { task: "agent", provider: providerName, outcome };
          metrics.modelOperations.inc(labels);
          metrics.modelDuration.observe(
            labels,
            (Date.now() - startedAt) / 1000
          );
        }
      }
    );
  }

  /**
   * Execute a tool with a bounded timeout so a stuck handler cannot prevent
   * toolCallResult emission and leave the frontend waiting indefinitely.
   *
   * @param {{handler: Function}} fn - The function config to execute.
   * @param {object} args - Tool arguments.
   * @param {string} name - Tool name.
   * @returns {Promise<any>} Tool result or a timeout error string.
   */
  async #executeToolHandler(fn, args = {}, name = "", toolCallId = null) {
    const timeoutMs = toolExecutionTimeoutMs(name);
    const startedAt = Date.now();
    let timeoutId = null;
    const timeoutResult = Symbol("tool-timeout");
    let outcome = "success";
    let toolCoverage = null;
    let toolCorrelation = null;
    const invocation = this.handlerProps?.invocation || {};

    this.handlerProps?.log?.(
      `[debug]: Tool ${name} handler started with timeout ${timeoutMs}ms`
    );

    try {
      const result = await runWithOperationContext(
        {
          invocationId: invocation.uuid,
          clientTurnId: invocation.clientTurnId,
          workspaceId: invocation.workspace_id,
          threadId: invocation.thread_id,
          toolCallId: toolCallId || v4(),
          journey: "agent_tool",
        },
        () =>
          withOperationSpan(
            "gen_ai.tool.execute",
            {
              kind: api.SpanKind.INTERNAL,
              attributes: {
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": String(name || "unknown").slice(0, 96),
              },
            },
            () => {
              toolCoverage = correlationCoverage([
                "invocationId",
                "toolCallId",
              ]);
              toolCorrelation = { ...(currentOperationContext() || {}) };
              return Promise.race([
                fn.handler(args),
                new Promise((resolve) => {
                  timeoutId = setTimeout(
                    () => resolve(timeoutResult),
                    timeoutMs
                  );
                }),
              ]);
            }
          )
      );

      const elapsedMs = Date.now() - startedAt;
      if (result === timeoutResult) {
        outcome = "timeout";
        const message = `Tool ${name} timed out after ${timeoutMs}ms.`;
        this.handlerProps?.log?.(`[warning]: ${message}`);
        this?.introspect?.(`${message} Continuing with a timeout result.`);
        return `Error: ${message}`;
      }

      this.handlerProps?.log?.(
        `[debug]: Tool ${name} handler completed in ${elapsedMs}ms`
      );
      if (result === undefined || result === null)
        return `Tool ${name} completed but returned no content.`;
      return result;
    } catch (error) {
      outcome = "failure";
      this.handlerProps?.log?.(
        `[error]: Tool ${name} handler failed after ${Date.now() - startedAt}ms: ${error.message}`
      );
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      const tool = String(name || "unknown").slice(0, 96);
      metrics.agentToolOperations.inc({ tool, outcome });
      metrics.agentToolDuration.observe(
        { tool, outcome },
        (Date.now() - startedAt) / 1000
      );
      metrics.goldenJourneyOperations.inc({
        journey: "agent_tool",
        outcome: outcome === "success" ? "success" : "failure",
      });
      metrics.goldenJourneyDuration.observe(
        {
          journey: "agent_tool",
          outcome: outcome === "success" ? "success" : "failure",
        },
        (Date.now() - startedAt) / 1000
      );
      const coverage =
        toolCoverage || correlationCoverage(["invocationId", "toolCallId"]);
      metrics.operationCorrelation.inc({
        component: "agent_tool",
        journey: "agent_tool",
        coverage: coverage.complete ? "complete" : "incomplete",
      });
      if (outcome !== "success") {
        emitSemanticEvent({
          eventType:
            outcome === "timeout"
              ? "agent.tool.timed_out"
              : "agent.tool.failed",
          category: "agent_tool",
          severity: "error",
          outcome,
          subject: { type: "tool", component: tool, operation: "execute" },
          impact: { userEffect: "agent_task_degraded" },
          evidence: [
            { type: "trace", ref: toolCorrelation?.traceId || "unavailable" },
          ],
          correlation: toolCorrelation,
          metadata: {
            errorCode:
              outcome === "timeout" ? "tool_timeout" : "tool_execution_failed",
            durationMs: Date.now() - startedAt,
          },
        });
      }
    }
  }

  async #modelResultForTool(fn, result, toolRun) {
    const projected =
      typeof fn?.prepareResultForModel === "function"
        ? await fn.prepareResultForModel(result, toolRun)
        : result;
    return prepareToolResultForModel(
      projected,
      toolRun,
      fn?.modelResultMaxChars
    );
  }

  #providerForToolContinuation(fn, currentProvider) {
    const resolved = continuationProviderConfigForFunction(fn);
    if (!resolved) return currentProvider;
    const provider = this.getProviderForConfig(resolved);
    provider.attachHandlerProps(this.handlerProps);
    this.handlerProps?.log?.(
      `[debug]: Tool ${fn.name} continuation is pinned to ${resolved.provider}:${resolved.model} via ${resolved.taskName}.`
    );
    return provider;
  }

  async #validatedContinuationForTool({
    fn,
    provider,
    messages,
    result,
    modelResult,
    toolRun,
  }) {
    if (typeof fn?.validatedContinuation !== "function") return null;
    const generate = async (extraMessages = [], options = {}) => {
      const { isolated = false, ...providerOptions } = options || {};
      const completionMessages = isolated
        ? [...extraMessages]
        : [...messages, ...extraMessages];
      const completion = await this.#safeProviderCall(
        () =>
          provider.complete(
            appendCurrentDateTimeToLastUserMessage(completionMessages),
            [],
            providerOptions
          ),
        provider
      );
      return completion?.textResponse || "";
    };
    return fn.validatedContinuation({
      result,
      modelResult,
      toolRun,
      generate,
      handlerProps: this.handlerProps,
    });
  }

  #emitToolCompleted({ name, toolCallId, toolRun, continuationTask = null }) {
    const invocation = this.handlerProps?.invocation || {};
    runWithOperationContext(
      {
        invocationId: invocation.uuid,
        clientTurnId: invocation.clientTurnId,
        workspaceId: invocation.workspace_id,
        threadId: invocation.thread_id,
        toolCallId,
        journey: "agent_tool",
      },
      () =>
        emitSemanticEvent({
          eventType: "agent.tool.completed",
          category: "agent_tool",
          severity: "info",
          outcome: "success",
          subject: {
            type: "tool",
            component: String(name || "unknown").slice(0, 96),
            operation: "execute",
          },
          impact: { userEffect: "agent_task_continued" },
          evidence: [
            {
              type: "trace",
              ref: currentOperationContext()?.traceId || "unavailable",
            },
          ],
          metadata: {
            runId: toolRun?.runId || null,
            resultSha256: toolRun?.resultSha256 || null,
            stored: Boolean(toolRun?.stored),
            resultSize: Number(toolRun?.resultSize || 0),
            fullResultExceededDefaultModelLimit: Boolean(toolRun?.truncated),
            continuationTask: continuationTask || null,
          },
        })
    );
  }

  /**
   * Handle the async (streaming) execution of the provider
   * with tool calls.
   *
   * @param provider
   * @param messages
   * @param functions
   * @param byAgent
   *
   * @returns {Promise<string>}
   */
  async handleAsyncExecution(
    provider,
    messages = [],
    functions = [],
    byAgent = null,
    depth = 0
  ) {
    let emittedFullTextResponse = false;
    const eventHandler = (type, data) => {
      if (!shouldForwardProviderStreamEvent(type, data)) return;
      if (type === "reportStreamEvent" && data?.type === "fullTextResponse") {
        emittedFullTextResponse = true;
      }
      this?.socket?.send(type, data);
    };

    /** @type {{ functionCall: { name: string, arguments: string }, textResponse: string }} */
    const completionStream = await this.#safeProviderCall(
      () =>
        provider.stream(
          appendCurrentDateTimeToLastUserMessage(messages),
          functions,
          eventHandler
        ),
      provider
    );

    if (completionStream.functionCall) {
      const { name, arguments: args } = completionStream.functionCall;
      const fn = this.functions.get(name);
      const reachedToolLimit = depth >= this.maxToolCalls;

      if (reachedToolLimit) {
        this.handlerProps?.log?.(
          `[warning]: Maximum tool call limit (${this.maxToolCalls}) reached. Executing final tool call then generating response.`
        );
        this?.introspect?.(
          `Maximum tool call limit (${this.maxToolCalls}) reached. After this tool I will generate a final response.`
        );
      }

      if (!fn) {
        return await this.handleAsyncExecution(
          provider,
          [
            ...messages,
            {
              name,
              role: "function",
              content: `Function "${name}" not found. Try again.`,
              originalFunctionCall: completionStream.functionCall,
            },
          ],
          reachedToolLimit ? [] : functions,
          byAgent,
          depth + 1
        );
      }

      fn.caller = byAgent || "agent";

      if (provider?.verbose) {
        this?.introspect?.(
          `${fn.caller} is executing \`${name}\` tool ${JSON.stringify(args, null, 2)}`
        );
      }

      this.handlerProps?.log?.(
        `[debug]: ${fn.caller} is attempting to call \`${name}\` tool ${JSON.stringify(args, null, 2)}`
      );

      const toolInvocationEvent = readyToolInvocationEvent(
        completionStream.functionCall,
        depth,
        completionStream.uuid || v4()
      );
      if (toolInvocationEvent)
        eventHandler("reportStreamEvent", toolInvocationEvent);

      const toolCallId =
        completionStream.functionCall?.id ||
        completionStream.functionCall?.call_id ||
        toolInvocationEvent?.uuid;
      const result = await this.#executeToolHandler(fn, args, name, toolCallId);
      const toolRun = await storeToolRun({
        toolName: name,
        arguments: args,
        result,
        resultPolicy: fn.resultPolicy || null,
      });
      const modelResult = await this.#modelResultForTool(fn, result, toolRun);
      this.#emitToolCompleted({
        name,
        toolCallId,
        toolRun,
        continuationTask: fn.continuationTask,
      });
      Telemetry.sendTelemetry("agent_tool_call", { tool: name }, null, true);
      this.emitter.emit("toolCallResult", {
        toolName: name,
        arguments: args,
        result: toolRun,
      });

      /**
       * If the tool call has direct output enabled, return the result directly to the chat
       * without any further processing and no further tool calls will be run.
       * For streaming, we need to return the result directly to the chat via the event handler
       * or else no response will be sent to the chat.
       */
      if (this.skipHandleExecution) {
        this.skipHandleExecution = false;
        this?.introspect?.(
          `The tool call has direct output enabled! The result will be returned directly to the chat without any further processing and no further tool calls will be run.`
        );
        this?.introspect?.(`Tool use completed.`);
        this.handlerProps?.log?.(
          `${fn.caller} tool call resulted in direct output! Returning raw result as string. NO MORE TOOL CALLS WILL BE EXECUTED.`
        );
        const directOutputUUID = completionStream?.uuid || v4();
        eventHandler?.("reportStreamEvent", {
          type: "fullTextResponse",
          uuid: directOutputUUID,
          content: modelResult,
        });
        eventHandler?.("reportStreamEvent", {
          type: "usageMetrics",
          uuid: directOutputUUID,
          metrics: provider.getUsage(),
        });
        this?.flushCitations?.(directOutputUUID);
        this?.stageResponseCompletion?.(directOutputUUID, provider.getUsage());
        return modelResult;
      }

      const toolAttachments = this.collectToolAttachments();
      const newMessages = [
        ...messages,
        {
          name,
          role: "function",
          content: modelResult,
          originalFunctionCall: completionStream.functionCall,
        },
      ];
      if (fn.continuationInstruction) {
        newMessages.push({
          role: "system",
          content: String(fn.continuationInstruction),
        });
      }

      if (toolAttachments.length > 0) {
        this.handlerProps?.log?.(
          `[debug]: Injecting ${toolAttachments.length} image attachment(s) from tool result`
        );
        newMessages.push({
          role: "user",
          content: "[Attached image(s) from tool result]",
          attachments: toolAttachments,
        });
      }

      if (name === REQUEST_USER_INPUT_TOOL_NAME) {
        const clarificationPromptTail =
          this.collectClarifyingQuestionPromptTail();
        if (clarificationPromptTail) {
          newMessages.push({
            role: "user",
            content: `Clarification answers:\n${clarificationPromptTail}`,
          });
        }
      }

      const continuationProvider = this.#providerForToolContinuation(
        fn,
        provider
      );
      const validatedContinuation = await this.#validatedContinuationForTool({
        fn,
        provider: continuationProvider,
        messages: newMessages,
        result,
        modelResult,
        toolRun,
      });
      if (validatedContinuation?.handled) {
        const responseUuid = completionStream?.uuid || v4();
        eventHandler?.("reportStreamEvent", {
          type: "fullTextResponse",
          uuid: responseUuid,
          content: validatedContinuation.text,
        });
        eventHandler?.("reportStreamEvent", {
          type: "usageMetrics",
          uuid: responseUuid,
          metrics: continuationProvider.getUsage(),
        });
        this?.flushCitations?.(responseUuid);
        this?.stageResponseCompletion?.(
          responseUuid,
          continuationProvider.getUsage()
        );
        return validatedContinuation.text;
      }
      return await this.handleAsyncExecution(
        continuationProvider,
        newMessages,
        reachedToolLimit ? [] : functions,
        byAgent,
        depth + 1
      );
    }

    const responseUuid = completionStream?.uuid || v4();
    if (!emittedFullTextResponse && completionStream?.textResponse) {
      eventHandler?.("reportStreamEvent", {
        type: "fullTextResponse",
        uuid: responseUuid,
        content: completionStream.textResponse,
      });
    }
    eventHandler?.("reportStreamEvent", {
      type: "usageMetrics",
      uuid: responseUuid,
      metrics: provider.getUsage(),
    });
    this?.flushCitations?.(responseUuid);
    this?.stageResponseCompletion?.(responseUuid, provider.getUsage());
    return completionStream?.textResponse;
  }

  /**
   * Handle the synchronous (non-streaming) execution of the provider
   * with tool calls.
   *
   * @param provider
   * @param messages
   * @param functions
   * @param byAgent
   * @param depth
   * @param msgUUID - The message UUID to use for event correlation (created at depth=0)
   *
   * @returns {Promise<string>}
   */
  async handleExecution(
    provider,
    messages = [],
    functions = [],
    byAgent = null,
    depth = 0,
    msgUUID = null
  ) {
    // Create a stable UUID at the start of execution for event correlation
    if (!msgUUID) msgUUID = v4();
    const eventHandler = (type, data) => {
      this?.socket?.send(type, data);
    };

    // get the chat completion
    const completion = await this.#safeProviderCall(
      () =>
        provider.complete(
          appendCurrentDateTimeToLastUserMessage(messages),
          functions
        ),
      provider
    );

    if (completion.functionCall) {
      const { name, arguments: args } = completion.functionCall;
      const fn = this.functions.get(name);
      const reachedToolLimit = depth >= this.maxToolCalls;

      if (reachedToolLimit) {
        this.handlerProps?.log?.(
          `[warning]: Maximum tool call limit (${this.maxToolCalls}) reached. Executing final tool call then generating response.`
        );
        this?.introspect?.(
          `Maximum tool call limit (${this.maxToolCalls}) reached. After this tool I will generate a final response.`
        );
      }

      if (!fn) {
        return await this.handleExecution(
          provider,
          [
            ...messages,
            {
              name,
              role: "function",
              content: `Function "${name}" not found. Try again.`,
              originalFunctionCall: completion.functionCall,
            },
          ],
          reachedToolLimit ? [] : functions,
          byAgent,
          depth + 1,
          msgUUID
        );
      }

      fn.caller = byAgent || "agent";

      if (provider?.verbose) {
        this?.introspect?.(
          `[debug]: ${fn.caller} is attempting to call \`${name}\` tool`
        );
      }

      this.handlerProps?.log?.(
        `[debug]: ${fn.caller} is attempting to call \`${name}\` tool`
      );

      const toolInvocationEvent = readyToolInvocationEvent(
        completion.functionCall,
        depth,
        msgUUID
      );
      if (toolInvocationEvent)
        eventHandler("reportStreamEvent", toolInvocationEvent);

      const toolCallId =
        completion.functionCall?.id ||
        completion.functionCall?.call_id ||
        toolInvocationEvent?.uuid;
      const result = await this.#executeToolHandler(fn, args, name, toolCallId);
      const toolRun = await storeToolRun({
        toolName: name,
        arguments: args,
        result,
        resultPolicy: fn.resultPolicy || null,
      });
      const modelResult = await this.#modelResultForTool(fn, result, toolRun);
      this.#emitToolCompleted({
        name,
        toolCallId,
        toolRun,
        continuationTask: fn.continuationTask,
      });
      Telemetry.sendTelemetry("agent_tool_call", { tool: name }, null, true);
      this.emitter.emit("toolCallResult", {
        toolName: name,
        arguments: args,
        result: toolRun,
      });

      if (this.skipHandleExecution) {
        this.skipHandleExecution = false;
        this?.introspect?.(
          `The tool call has direct output enabled! The result will be returned directly to the chat without any further processing and no further tool calls will be run.`
        );
        this?.introspect?.(`Tool use completed.`);
        this.handlerProps?.log?.(
          `${fn.caller} tool call resulted in direct output! Returning raw result as string. NO MORE TOOL CALLS WILL BE EXECUTED.`
        );
        eventHandler?.("reportStreamEvent", {
          type: "usageMetrics",
          uuid: msgUUID,
          metrics: provider.getUsage(),
        });
        this?.flushCitations?.(msgUUID);
        this?.stageResponseCompletion?.(msgUUID, provider.getUsage());
        return modelResult;
      }

      const toolAttachments = this.collectToolAttachments();
      const newMessages = [
        ...messages,
        {
          name,
          role: "function",
          content: modelResult,
          originalFunctionCall: completion.functionCall,
        },
      ];
      if (fn.continuationInstruction) {
        newMessages.push({
          role: "system",
          content: String(fn.continuationInstruction),
        });
      }

      if (toolAttachments.length > 0) {
        this.handlerProps?.log?.(
          `[debug]: Injecting ${toolAttachments.length} image attachment(s) from tool result`
        );
        newMessages.push({
          role: "user",
          content: "[Attached image(s) from tool result]",
          attachments: toolAttachments,
        });
      }

      if (name === REQUEST_USER_INPUT_TOOL_NAME) {
        const clarificationPromptTail =
          this.collectClarifyingQuestionPromptTail();
        if (clarificationPromptTail) {
          newMessages.push({
            role: "user",
            content: `Clarification answers:\n${clarificationPromptTail}`,
          });
        }
      }

      const continuationProvider = this.#providerForToolContinuation(
        fn,
        provider
      );
      const validatedContinuation = await this.#validatedContinuationForTool({
        fn,
        provider: continuationProvider,
        messages: newMessages,
        result,
        modelResult,
        toolRun,
      });
      if (validatedContinuation?.handled) {
        eventHandler?.("reportStreamEvent", {
          type: "usageMetrics",
          uuid: msgUUID,
          metrics: continuationProvider.getUsage(),
        });
        this?.flushCitations?.(msgUUID);
        this?.stageResponseCompletion?.(
          msgUUID,
          continuationProvider.getUsage()
        );
        return validatedContinuation.text;
      }
      return await this.handleExecution(
        continuationProvider,
        newMessages,
        reachedToolLimit ? [] : functions,
        byAgent,
        depth + 1,
        msgUUID
      );
    }

    eventHandler?.("reportStreamEvent", {
      type: "usageMetrics",
      uuid: msgUUID,
      metrics: provider.getUsage(),
    });
    this?.flushCitations?.(msgUUID);
    this?.stageResponseCompletion?.(msgUUID, provider.getUsage());
    return completion?.textResponse;
  }

  /**
   * Continue the chat from the last interruption.
   * If the last chat was not an interruption, it will throw an error.
   * Provide a feedback where it was interrupted if you want to.
   *
   * @param feedback The feedback to the interruption if any.
   * @param attachments Optional attachments (images) to include with the feedback.
   * @returns
   */
  async continue(feedback, attachments = []) {
    const lastChat = this._chats.at(-1);
    if (!lastChat || lastChat.state !== "interrupt") {
      throw new Error("No chat to continue");
    }

    // remove the last chat's that was interrupted
    this._chats.pop();

    const { from, to } = lastChat;

    if (this.hasReachedMaximumRounds(from, to)) {
      throw new Error("Maximum rounds reached");
    }

    if (feedback) {
      const message = {
        from,
        to,
        content: feedback,
        ...(attachments?.length > 0 ? { attachments } : {}),
      };

      // register the message in the chat history
      this.newMessage(message);

      // ask the node to reply
      await this.chat({
        to: message.from,
        from: message.to,
      });
    } else {
      await this.chat({ from, to });
    }

    return this;
  }

  /**
   * Retry the last chat that threw an error.
   * If the last chat was not an error, it will throw an error.
   */
  async retry() {
    const lastChat = this._chats.at(-1);
    if (!lastChat || lastChat.state !== "error") {
      throw new Error("No chat to retry");
    }

    // remove the last chat's that threw an error
    // eslint-disable-next-line
    const { from, to } = this?._chats?.pop();

    await this.chat({ from, to });
    return this;
  }

  /**
   * Get the chat history between two nodes or all chats to/from a node.
   */
  getHistory({ from, to }) {
    return this._chats.filter((chat) => {
      const isSuccess = chat.state === "success";

      // return all chats to the node
      if (!from) {
        return isSuccess && chat.to === to;
      }

      // get all chats from the node
      if (!to) {
        return isSuccess && chat.from === from;
      }

      // check if the chat is between the two nodes
      const hasSent = chat.from === from && chat.to === to;
      const hasReceived = chat.from === to && chat.to === from;
      const mutual = hasSent || hasReceived;

      return isSuccess && mutual;
    });
  }

  /**
   * Get provider based on configurations.
   * If the provider is a string, it will return the default provider for that string.
   *
   * @param config The provider configuration.
   * @returns {Providers.OpenAIProvider} The provider instance.
   */
  getProviderForConfig(config) {
    if (typeof config.provider === "object") return config.provider;
    const {
      agentEnabled,
      createResponsesAgentProvider,
    } = require("../../responsesRuntime/agentAdapter");
    if (
      agentEnabled({
        provider: config.provider,
        model: config.model,
        env: process.env,
      })
    )
      return createResponsesAgentProvider({
        provider: config.provider,
        model: config.model,
        env: process.env,
      });
    const {
      agentGatewayEnabled,
      createRemoteAgentProvider,
    } = require("../../modelGateway/agentRemoteProvider");
    if (agentGatewayEnabled(process.env))
      return createRemoteAgentProvider({
        provider: config.provider,
        model: config.model,
        env: process.env,
      });
    const provider = createAgentProvider(config);
    return provider;
  }

  /**
   * Register a new function to be called by the AIbitat agents.
   * You are also required to specify the which node can call the function.
   * @param functionConfig The function configuration.
   */
  function(functionConfig) {
    this.functions.set(functionConfig.name, functionConfig);
    return this;
  }
}

module.exports = AIbitat;
module.exports.continuationProviderConfigForFunction =
  continuationProviderConfigForFunction;
module.exports.readyToolInvocationEvent = readyToolInvocationEvent;
module.exports.shouldForwardProviderStreamEvent =
  shouldForwardProviderStreamEvent;
