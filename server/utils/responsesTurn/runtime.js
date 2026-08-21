const { v4: uuidv4 } = require("uuid");
const {
  createRemoteAgentInvocation,
  cancelRemoteAgentInvocation,
  remoteAgentInvocationEnabled,
  submitRemoteAgentAction,
  streamRemoteAgentInvocation,
} = require("../agents/invocationClient");
const { DataAccessCenter } = require("../dataAccess");
const { DEEPSEEK_RESPONSE_MODELS } = require("../responsesRuntime/contract");
const {
  sanitizeReasoningText,
} = require("../responsesRuntime/reasoningStream");
const { newPublicChatId } = require("../chats/chatIdentifiers");

const activeResponsesTurns = new Map();

function normalizedPrompt(message = "") {
  const stripped = String(message)
    .replace(/^\s*@agent\s*/i, "")
    .trim();
  return stripped || "Hello!";
}

function localAgentRuntime() {
  return require("../../endpoints/agentWebsocket");
}

function responseEnvelope(responseId, status, extra = {}) {
  return {
    id: responseId,
    object: "response",
    status,
    created_at: Math.floor(Date.now() / 1000),
    error: null,
    incomplete_details: null,
    output: [],
    ...extra,
  };
}

class ResponsesTurnProjector {
  constructor({
    responseId,
    emit,
    chatId = null,
    publicChatId = null,
    clientTurnId = null,
  }) {
    this.responseId = responseId;
    this.emitRaw = emit;
    this.sequence = 0;
    this.toolVisible = false;
    this.pendingThoughts = [];
    this.text = "";
    this.chatId = chatId;
    this.publicChatId = publicChatId;
    this.clientTurnId = clientTurnId;
    this.metrics = {};
    this.reasoningStarted = false;
    this.reasoningDone = false;
    this.terminal = false;
    this.emit("response.created", {
      response: responseEnvelope(responseId, "in_progress", {
        metadata: {
          chatId: this.chatId,
          publicChatId: this.publicChatId,
          clientTurnId: this.clientTurnId,
        },
      }),
    });
    this.emit("response.in_progress", {
      response: responseEnvelope(responseId, "in_progress", {
        metadata: {
          chatId: this.chatId,
          publicChatId: this.publicChatId,
          clientTurnId: this.clientTurnId,
        },
      }),
    });
  }

  emit(type, payload = {}) {
    if (this.terminal) return;
    this.sequence += 1;
    this.emitRaw({
      type,
      sequence_number: this.sequence,
      response_id: this.responseId,
      ...payload,
    });
  }

  flushThoughts() {
    if (!this.toolVisible || !this.pendingThoughts.length) return;
    for (const content of this.pendingThoughts.splice(0)) {
      this.emit("athena.tool.progress", { content });
    }
  }

  toolStarted(content = {}) {
    this.toolVisible = true;
    this.flushThoughts();
    const callId = content.callId || content.uuid || uuidv4();
    const item = {
      id: callId,
      type: "function_call",
      call_id: callId,
      name: content.toolName || "tool",
      arguments: JSON.stringify(content.arguments || {}),
      status: "in_progress",
    };
    this.emit("response.output_item.added", { item, output_index: 0 });
    this.emit("athena.tool.started", {
      call_id: callId,
      tool_name: item.name,
      content: content.content || `正在使用 ${item.name}`,
    });
  }

  toolCompleted(content = {}) {
    this.toolVisible = true;
    this.flushThoughts();
    const callId = content.callId || content.uuid || uuidv4();
    this.emit("athena.tool.completed", {
      call_id: callId,
      tool_name: content.toolName || "tool",
      content: content.summary || content.content || "工具执行完成",
      result: content.result || null,
    });
    this.emit("response.output_item.done", {
      output_index: 0,
      item: {
        id: callId,
        type: "function_call",
        call_id: callId,
        name: content.toolName || "tool",
        status: "completed",
      },
    });
  }

  appendText(delta = "") {
    delta = String(delta || "");
    if (!delta) return;
    this.finishReasoning("completed");
    this.text += delta;
    this.emit("response.output_text.delta", {
      item_id: `${this.responseId}:message`,
      output_index: 0,
      content_index: 0,
      delta,
    });
  }

  startReasoning() {
    if (this.reasoningStarted || this.reasoningDone) return;
    this.reasoningStarted = true;
    this.emit("athena.reasoning.started", {
      item_id: `${this.responseId}:reasoning`,
    });
  }

  appendReasoning(content = {}) {
    const delta = sanitizeReasoningText(content.content || "").trim();
    if (!delta) return;
    this.startReasoning();
    this.emit("athena.reasoning.delta", {
      item_id: `${this.responseId}:reasoning`,
      content_index: Math.max(0, Number(content.sequence || 1) - 1),
      delta,
      truncated: content.truncated === true,
    });
  }

  finishReasoning(status = "completed", content = {}) {
    if (!this.reasoningStarted || this.reasoningDone) return;
    this.reasoningDone = true;
    this.emit("athena.reasoning.done", {
      item_id: `${this.responseId}:reasoning`,
      status,
      truncated: content.truncated === true,
    });
  }

  agentProgress(content = {}) {
    this.emit("athena.agent.progress", {
      item_id: `${this.responseId}:agent-progress`,
      uuid: content.uuid || null,
      phase: content.phase,
      status: content.status,
      sequence: content.sequence,
      details: content.details || {},
    });
  }

  accept(event = {}) {
    if (this.terminal || !event) return;
    if (event.type === "statusResponse") {
      const text = String(event.content || "").trim();
      if (text) this.pendingThoughts.push(text);
      this.flushThoughts();
      return;
    }
    if (event.type === "toolApprovalRequest") {
      this.toolVisible = true;
      this.flushThoughts();
      this.emit("athena.approval.required", {
        action_id: event.requestId,
        request_id: event.requestId,
        tool_name: event.skillName,
        description: event.description || null,
        payload: event.payload || {},
      });
      return;
    }
    if (event.type === "clarifyingQuestion") {
      this.toolVisible = true;
      this.flushThoughts();
      this.emit("athena.clarification.required", {
        action_id: event.requestId,
        request_id: event.requestId,
        questions: event.questions || event.content?.questions || [],
      });
      return;
    }
    if (event.type === "reportStreamEvent") {
      const content = event.content || {};
      if (content.type === "toolCallInvocation")
        return this.toolStarted(content);
      if (content.type === "toolCallResult") return this.toolCompleted(content);
      if (content.type === "agentProgress") return this.agentProgress(content);
      if (content.type === "reasoningContentStart") {
        this.startReasoning();
        return;
      }
      if (content.type === "reasoningContentChunk")
        return this.appendReasoning(content);
      if (content.type === "reasoningContentDone") {
        this.finishReasoning(content.status || "completed", content);
        return;
      }
      if (content.type === "textResponseChunk")
        return this.appendText(content.content);
      if (content.type === "fullTextResponse") {
        const full = String(content.content || "");
        if (!this.text) this.appendText(full);
        else if (full.startsWith(this.text))
          this.appendText(full.slice(this.text.length));
        return;
      }
      if (content.type === "usageMetrics") {
        this.metrics = content.metrics || {};
        return;
      }
      if (content.type === "citations") {
        this.emit("athena.citations", {
          item_id: `${this.responseId}:message`,
          citations: Array.isArray(content.citations) ? content.citations : [],
        });
        return;
      }
      if (content.type === "chatId") {
        this.chatId = content.chatId || null;
        this.publicChatId = content.publicChatId || this.publicChatId;
      }
      return;
    }
    if (event.type === "wssFailure" || event.type === "response.failed") {
      return this.fail(
        event.response?.error?.code || "responses_turn_failed",
        event.response?.error?.message ||
          event.content ||
          "Responses turn failed."
      );
    }
    if (event.type === "response.incomplete") {
      return this.incomplete(
        event.response?.incomplete_details?.reason || "generation_incomplete"
      );
    }
    if (event.type === "response.cancelled") return this.cancel();
    if (event.type === "response.completed") {
      this.complete(event.response || {});
    }
  }

  complete(innerResponse = {}) {
    if (this.terminal) return;
    this.pendingThoughts = [];
    this.finishReasoning("completed");
    this.emit("response.output_text.done", {
      item_id: `${this.responseId}:message`,
      output_index: 0,
      content_index: 0,
      text: this.text,
    });
    this.emit("response.completed", {
      response: responseEnvelope(this.responseId, "completed", {
        completed_at: Math.floor(Date.now() / 1000),
        usage: innerResponse?.usage || this.metrics || {},
        metadata: {
          chatId: innerResponse?.metadata?.chatId || this.chatId || null,
          publicChatId:
            innerResponse?.metadata?.publicChatId || this.publicChatId || null,
          clientTurnId:
            this.clientTurnId || innerResponse?.metadata?.clientTurnId || null,
        },
      }),
    });
    this.terminal = true;
  }

  fail(code, message) {
    if (this.terminal) return;
    this.finishReasoning("failed");
    this.emit("response.failed", {
      response: responseEnvelope(this.responseId, "failed", {
        error: { code, message },
      }),
    });
    this.terminal = true;
  }

  incomplete(reason = "generation_incomplete") {
    if (this.terminal) return;
    this.finishReasoning("incomplete");
    this.emit("response.incomplete", {
      response: responseEnvelope(this.responseId, "incomplete", {
        incomplete_details: { reason },
      }),
    });
    this.terminal = true;
  }

  cancel() {
    if (this.terminal) return;
    this.finishReasoning("cancelled");
    this.emit("response.cancelled", {
      response: responseEnvelope(this.responseId, "cancelled"),
    });
    this.terminal = true;
  }
}

async function executeResponsesTurn({
  responseId,
  emit,
  workspace,
  user = null,
  thread = null,
  message,
  displayPrompt = null,
  attachments = [],
  fileAccess = {},
  clientTurnId = null,
} = {}) {
  // Allocate the durable public identity as soon as the Responses connection
  // is established, but do not create a WorkspaceChats row yet. The final chat
  // is committed only after the Agent Runtime emits a valid completed terminal.
  const reservedPublicChatId = newPublicChatId();
  const projector = new ResponsesTurnProjector({
    responseId,
    emit,
    chatId: null,
    publicChatId: reservedPublicChatId,
    clientTurnId,
  });
  const executionTarget = {
    provider: String(workspace?.chatProvider || workspace?.agentProvider || ""),
    model: String(workspace?.chatModel || workspace?.agentModel || ""),
  };
  if (
    executionTarget.provider !== "deepseek" ||
    !DEEPSEEK_RESPONSE_MODELS.includes(executionTarget.model)
  ) {
    const error = Object.assign(new Error("responses_model_not_supported"), {
      code: "responses_model_not_supported",
      httpStatus: 400,
    });
    projector.fail(error.code, error.message);
    throw error;
  }
  const submission = {
    prompt: normalizedPrompt(message),
    workspace,
    user,
    thread,
    clientTurnId,
  };
  try {
    const result = remoteAgentInvocationEnabled()
      ? await createRemoteAgentInvocation(submission)
      : await DataAccessCenter.workspaceAgentInvocation.new(submission);
    const invocation = result?.invocation;
    if (!invocation?.uuid)
      throw Object.assign(new Error("agent_invocation_store_unavailable"), {
        code: "agent_invocation_store_unavailable",
      });
    activeResponsesTurns.set(responseId, invocation.uuid);

    const streamOptions = {
      invocationId: invocation.uuid,
      uuid: invocation.uuid,
      attachments,
      displayAttachments: attachments,
      displayPrompt: displayPrompt || normalizedPrompt(message),
      reservedPublicChatId,
      fileAccess,
      executionTarget,
      onEvent: (event) => projector.accept(event),
    };
    if (remoteAgentInvocationEnabled())
      await streamRemoteAgentInvocation(streamOptions);
    else await localAgentRuntime().streamAgentInvocation(streamOptions);

    if (!projector.terminal)
      projector.fail(
        "responses_terminal_missing",
        "Responses turn ended without a terminal event."
      );
  } catch (error) {
    projector.fail(
      error?.code || "responses_turn_failed",
      error?.message || "Responses turn failed."
    );
    throw error;
  } finally {
    activeResponsesTurns.delete(responseId);
  }
}

async function cancelResponsesTurn(responseId) {
  const invocationId = activeResponsesTurns.get(String(responseId));
  if (!invocationId) return false;
  if (remoteAgentInvocationEnabled())
    await cancelRemoteAgentInvocation(invocationId);
  else await localAgentRuntime().cancelAgentInvocation(invocationId);
  return true;
}

async function submitResponsesTurnAction(responseId, actionId, body = {}) {
  const invocationId = activeResponsesTurns.get(String(responseId));
  if (!invocationId)
    return { success: false, error: "response_action_not_waiting" };
  if (remoteAgentInvocationEnabled())
    return submitRemoteAgentAction({ invocationId, actionId, body });
  return localAgentRuntime().submitAgentInvocationAction(
    invocationId,
    actionId,
    body
  );
}

module.exports = {
  ResponsesTurnProjector,
  cancelResponsesTurn,
  executeResponsesTurn,
  normalizedPrompt,
  submitResponsesTurnAction,
};
