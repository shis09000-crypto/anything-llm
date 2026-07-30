const { EventEmitter } = require("events");

const mockCheckpoint = jest.fn(async () => true);
const mockSettle = jest.fn(async () => true);
const mockGetScoped = jest.fn(async () => null);
const mockClaim = jest.fn(async (scope) => ({
  created: true,
  run: {
    id: "run-1",
    ...scope,
    status: "running",
    revision: 0,
    partialResponse: "",
  },
}));
const mockAppendEvents = jest.fn(async () => 1);
const mockRenewLease = jest.fn(async () => true);
const mockEventsAfter = jest.fn(async () => []);
const mockReconcileExpired = jest.fn(async () => null);

jest.mock("../../utils/dataAccess", () => ({
  DataAccessCenter: {
    chatStreamRun: {
      checkpoint: (...args) => mockCheckpoint(...args),
      settle: (...args) => mockSettle(...args),
      getScoped: (...args) => mockGetScoped(...args),
      claim: (...args) => mockClaim(...args),
      appendEvents: (...args) => mockAppendEvents(...args),
      renewLease: (...args) => mockRenewLease(...args),
      eventsAfter: (...args) => mockEventsAfter(...args),
      reconcileExpired: (...args) => mockReconcileExpired(...args),
    },
  },
}));

const {
  ChatStreamRuntime,
  ChatStreamRunManager,
} = require("../../utils/chats/chatStreamRuns");

class TestResponse extends EventEmitter {
  constructor() {
    super();
    this.frames = [];
    this.destroyed = false;
    this.writableEnded = false;
  }

  write(frame) {
    this.frames.push(String(frame));
    return true;
  }

  end() {
    this.writableEnded = true;
  }

  payloads() {
    return this.frames.flatMap((frame) =>
      frame
        .split(/\n\n+/)
        .filter(Boolean)
        .map((entry) => JSON.parse(entry.replace(/^data:\s*/, "")))
    );
  }
}

function run(overrides = {}) {
  return {
    id: "run-1",
    clientTurnId: "turn-1",
    workspaceId: 7,
    threadId: 8,
    userId: 9,
    status: "running",
    revision: 0,
    partialResponse: "",
    ...overrides,
  };
}

describe("durable chat stream runs", () => {
  beforeEach(() => {
    mockCheckpoint.mockClear();
    mockSettle.mockClear();
    mockGetScoped.mockClear();
    mockClaim.mockClear();
    mockAppendEvents.mockClear();
    mockRenewLease.mockClear();
    mockEventsAfter.mockClear();
    mockReconcileExpired.mockClear();
  });

  test("keeps accumulating after a subscriber disconnects and replays a complete snapshot", async () => {
    const runtime = new ChatStreamRuntime(run());
    const first = new TestResponse();
    void runtime.attach(first, 0);

    for (let index = 0; index < 250; index += 1) {
      runtime.acceptPayload({
        type: "textResponseChunk",
        textResponse: `${index},`,
      });
    }
    first.emit("close");

    for (let index = 250; index < 500; index += 1) {
      runtime.acceptPayload({
        type: "textResponseChunk",
        textResponse: `${index},`,
      });
    }

    const second = new TestResponse();
    void runtime.attach(second, 250);
    const snapshot = second
      .payloads()
      .find((payload) => payload.type === "fullTextResponse");
    expect(snapshot.textResponse).toBe(
      Array.from({ length: 500 }, (_, index) => `${index},`).join("")
    );
    expect(snapshot.runRevision).toBe(500);

    runtime.acceptPayload({
      type: "finalizeResponseStream",
      close: true,
      chatId: 42,
      publicChatId: "public-42",
    });
    await runtime.settle("completed");

    expect(mockSettle).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "completed",
        revision: 501,
        finalChatId: 42,
        partialResponse: snapshot.textResponse,
      })
    );
    expect(
      second
        .payloads()
        .filter((payload) => payload.type === "finalizeResponseStream")
    ).toHaveLength(1);
  });

  test("explicit cancellation aborts the provider-owned sink but not subscriber close", () => {
    const runtime = new ChatStreamRuntime(run());
    const response = new TestResponse();
    let providerClosed = 0;
    runtime.sink.on("close", () => {
      providerClosed += 1;
    });
    void runtime.attach(response, 0);

    response.emit("close");
    expect(providerClosed).toBe(0);
    expect(runtime.cancel()).toBe(true);
    expect(providerClosed).toBe(1);
    expect(runtime.cancel()).toBe(false);
  });

  test("manager delegates duplicate claims to the persistent idempotency boundary", async () => {
    const manager = new ChatStreamRunManager();
    const scope = {
      clientTurnId: "turn-idempotent",
      workspaceId: 1,
      threadId: null,
      userId: 2,
    };
    await manager.claim(scope);
    await manager.claim(scope);
    expect(mockClaim).toHaveBeenCalledTimes(2);
    expect(mockClaim).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining(scope)
    );
    expect(mockClaim).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining(scope)
    );
  });

  test("state exposes resumable metadata without partial response content", async () => {
    mockGetScoped.mockResolvedValueOnce(
      run({
        status: "completed",
        revision: 17,
        partialResponse: "private generated answer",
        finalChatId: 42,
        finalPublicChatId: "public-42",
        completedAt: "2026-07-26T12:00:00.000Z",
      })
    );
    const manager = new ChatStreamRunManager();

    const state = await manager.state({
      clientTurnId: "turn-1",
      workspaceId: 7,
      threadId: 8,
      userId: 9,
    });

    expect(state).toMatchObject({
      kind: "chat",
      clientTurnId: "turn-1",
      status: "completed",
      revision: 17,
      terminal: true,
      retryable: false,
      finalChatId: 42,
      finalPublicChatId: "public-42",
    });
    expect(state).not.toHaveProperty("partialResponse");
    expect(JSON.stringify(state)).not.toContain("private generated answer");
  });
});
