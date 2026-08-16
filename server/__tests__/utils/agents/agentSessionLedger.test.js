/* eslint-env jest */
const fs = require("fs");
const os = require("os");
const path = require("path");

describe("agentSessionLedger", () => {
  let storageDir;
  let ledger;

  beforeEach(() => {
    jest.resetModules();
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ledger-"));
    process.env.STORAGE_DIR = storageDir;
    ledger = require("../../../utils/agents/agentSessionLedger");
  });

  afterEach(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
    delete process.env.STORAGE_DIR;
  });

  it("records sequential socket events and replays only events after lastEventSeq", () => {
    const first = ledger.recordAgentSessionEvent("abc", {
      type: "statusResponse",
      content: "Thinking",
    });
    const second = ledger.recordAgentSessionEvent("abc", {
      type: "reportStreamEvent",
      content: {
        type: "textResponseChunk",
        uuid: "msg-1",
        content: "hello",
      },
    });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(second.payload.content.seq).toBe(2);
    expect(ledger.readAgentSessionEvents("abc", 1)).toEqual([second]);
  });

  it("summarizes tool events and partial output in invocation state", () => {
    ledger.recordAgentSessionEvent("abc", {
      type: "reportStreamEvent",
      content: {
        type: "toolCallResult",
        uuid: "tool-result-1",
        toolName: "get_workspace_supplement",
        summary: "Tool completed.",
        runId: "run-1",
        stored: true,
      },
    });
    ledger.recordAgentSessionEvent("abc", {
      type: "reportStreamEvent",
      content: {
        type: "fullTextResponse",
        uuid: "msg-1",
        content: "final answer",
      },
    });

    const state = ledger.getAgentSessionState("abc");
    expect(state.latestSeq).toBe(2);
    expect(state.toolEventsCount).toBe(1);
    expect(state.partialTextPreview).toContain("final answer");
    expect(state.status).toBe("finalizing");
    expect(state.retryable).toBe(true);
  });

  it("replaces streamed preview with the authoritative full response", () => {
    ledger.recordAgentSessionEvent("dedupe", {
      type: "reportStreamEvent",
      content: {
        type: "textResponseChunk",
        uuid: "msg-1",
        content: "final ",
      },
    });
    ledger.recordAgentSessionEvent("dedupe", {
      type: "reportStreamEvent",
      content: {
        type: "textResponseChunk",
        uuid: "msg-1",
        content: "answer",
      },
    });
    ledger.recordAgentSessionEvent("dedupe", {
      type: "reportStreamEvent",
      content: {
        type: "fullTextResponse",
        uuid: "msg-1",
        content: "final answer",
      },
    });
    ledger.recordAgentSessionEvent("dedupe", {
      to: "USER",
      from: "@agent",
      content: "final answer",
      state: "success",
    });

    expect(ledger.getAgentSessionState("dedupe").partialTextPreview).toBe(
      "final answer"
    );
  });

  it("redacts account-private output from replay while preserving live delivery", () => {
    ledger.recordAgentSessionEvent("private", {
      type: "reportStreamEvent",
      content: {
        type: "toolCallInvocation",
        toolName: "crypto_account_overview",
      },
    });
    const result = ledger.recordAgentSessionEvent("private", {
      type: "reportStreamEvent",
      content: {
        type: "fullTextResponse",
        content: "private balance 12345",
      },
    });

    expect(result.deliveryPayload.content.content).toBe(
      "private balance 12345"
    );
    expect(result.payload.content.content).toBe(
      "[account-private output redacted]"
    );
    expect(
      JSON.stringify(ledger.readAgentSessionEvents("private"))
    ).not.toContain("private balance 12345");
    expect(
      ledger.getAgentSessionState("private").partialTextPreview
    ).not.toContain("private balance 12345");
  });

  it("marks finalized chat output terminal without closing the reusable invocation", () => {
    ledger.recordAgentSessionEvent("terminal", {
      type: "reportStreamEvent",
      content: {
        type: "chatId",
        chatId: 87,
        publicChatId: "public-87",
        clientTurnId: "turn-87",
      },
    });

    expect(ledger.getAgentSessionState("terminal")).toMatchObject({
      status: "completed",
      terminal: true,
      retryable: false,
      closed: false,
      finalChatId: 87,
      finalPublicChatId: "public-87",
      clientTurnId: "turn-87",
    });
  });

  it("uses response.completed as the authoritative terminal event", () => {
    const event = ledger.recordAgentSessionEvent("responses-terminal", {
      type: "response.completed",
      response: {
        id: "ath_resp_123",
        object: "response",
        status: "completed",
        completed_at: 123,
        metadata: { clientTurnId: "turn-123" },
      },
    });

    expect(event.payload.sequence_number).toBe(1);
    expect(ledger.getAgentSessionState("responses-terminal")).toMatchObject({
      status: "completed",
      terminal: true,
      retryable: false,
      closed: false,
    });
  });

  it("does not regress completed state when a late final envelope arrives", () => {
    ledger.recordAgentSessionEvent("terminal-late-envelope", {
      type: "reportStreamEvent",
      content: {
        type: "chatId",
        chatId: 88,
        publicChatId: "public-88",
        clientTurnId: "turn-88",
      },
    });
    ledger.recordAgentSessionEvent("terminal-late-envelope", {
      to: "USER",
      from: "@agent",
      content: "final answer",
      state: "success",
    });

    expect(ledger.getAgentSessionState("terminal-late-envelope")).toMatchObject(
      {
        status: "completed",
        terminal: true,
        retryable: false,
        finalChatId: 88,
        partialTextPreview: "final answer",
      }
    );
  });

  it("coalesces high-frequency text deltas into a durable checkpoint", () => {
    const makeRecord = (seq, content) => ({
      seq,
      eventType: "textResponseChunk",
      createdAt: seq,
      payload: {
        type: "reportStreamEvent",
        seq,
        content: {
          type: "textResponseChunk",
          uuid: "msg-1",
          seq,
          content,
          textResponse: content,
        },
      },
    });

    const merged = ledger._internals.mergeDurableTextRecords(
      makeRecord(41, "hello "),
      makeRecord(42, "world")
    );

    expect(merged.seq).toBe(42);
    expect(merged.payload.seq).toBe(42);
    expect(merged.payload.content.seq).toBe(42);
    expect(merged.payload.content.content).toBe("hello world");
    expect(merged.payload.content.textResponse).toBe("hello world");
  });
});
