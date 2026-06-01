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
});
