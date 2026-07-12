const sequence = [];
const mockTruncateForNativeEdit = jest.fn();
const mockRegenerateLastTurn = jest.fn();
const mockWorkspaceChatGet = jest.fn();
const mockStreamChatWithWorkspace = jest.fn();
const mockPublishWorkspaceSyncEvent = jest.fn();
const mockFlushDurableCommits = jest.fn();

function captureApp() {
  const routes = { post: {} };
  return {
    routes,
    post(path, _middleware, handler) {
      routes.post[path] = handler;
    },
  };
}

function response() {
  const chunks = [];
  const res = {
    locals: { workspace: { id: 7, slug: "alpha", chatMode: "chat" } },
    chunks,
    statusCode: 200,
    destroyed: false,
    writableEnded: false,
    status: jest.fn(function (code) {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn(function (payload) {
      res.jsonPayload = payload;
      return res;
    }),
    setHeader: jest.fn(),
    flushHeaders: jest.fn(() => sequence.push("headers")),
    write: jest.fn((value) => {
      const match = String(value).match(/^data: (.+)\n\n$/);
      if (match) {
        const payload = JSON.parse(match[1]);
        chunks.push(payload);
        sequence.push(payload.type);
      }
      return true;
    }),
    end: jest.fn(function () {
      res.writableEnded = true;
      return res;
    }),
    once: jest.fn(),
    off: jest.fn(),
  };
  return res;
}

function loadRoutes() {
  jest.resetModules();
  jest.doMock("../../utils/http", () => ({
    reqBody: (request) => request.body || {},
    userFromSession: () => Promise.resolve({ id: 9, dailyMessageLimit: 100 }),
    multiUserMode: () => true,
  }));
  jest.doMock("../../utils/middleware/validatedRequest", () => ({
    validatedRequest: (_request, _response, next) => next?.(),
  }));
  jest.doMock("../../utils/middleware/multiUserProtected", () => ({
    flexUserRoleValid: () => (_request, _response, next) => next?.(),
    ROLES: { all: "all" },
  }));
  jest.doMock("../../utils/middleware/validWorkspace", () => ({
    validWorkspaceSlug: (_request, _response, next) => next?.(),
    validWorkspaceAndThreadSlug: (_request, _response, next) => next?.(),
  }));
  jest.doMock("../../utils/dataAccess", () => ({
    DataAccessCenter: {
      user: { canSendChat: () => Promise.resolve(true) },
      workspaceChat: {
        get: (...args) => mockWorkspaceChatGet(...args),
        truncateForNativeEdit: (...args) => mockTruncateForNativeEdit(...args),
        regenerateLastTurn: (...args) => mockRegenerateLastTurn(...args),
      },
    },
  }));
  jest.doMock("../../utils/chats/stream", () => ({
    streamChatWithWorkspace: (...args) => mockStreamChatWithWorkspace(...args),
  }));
  jest.doMock("../../utils/chats/workspaceSyncEvents", () => ({
    publishWorkspaceSyncEvent: (...args) =>
      mockPublishWorkspaceSyncEvent(...args),
  }));
  jest.doMock("../../utils/broadcast", () => ({
    _internals: {
      flushDurableCommits: (...args) => mockFlushDurableCommits(...args),
    },
  }));
  jest.doMock("../../repositories/telemetryRepository", () => ({
    TelemetryRepository: { sendTelemetry: jest.fn() },
  }));
  jest.doMock("../../repositories/eventLogRepository", () => ({
    EventLogRepository: { logEvent: jest.fn() },
  }));
  jest.doMock("../../utils/clientIdentity", () => ({
    getClientContext: () => ({ clientId: "ios-client" }),
    recordClientTrustCheckpoint: jest.fn(),
  }));
  jest.doMock("../../utils/security/transportSecurity", () => ({
    setSseTransportHeaders: jest.fn(),
  }));
  jest.doMock("../../utils/chats/threadChatModel", () => ({
    workspaceWithThreadChatModel: (workspace) => workspace,
  }));
  jest.doMock("../../utils/chats/threadTitleEvents", () => ({
    subscribeToThreadTitleUpdates: () => () => {},
  }));
  jest.doMock("../../utils/chats/toolApproval", () => ({
    respondToChatToolApproval: jest.fn(),
  }));
  jest.doMock("../../utils/helpers/chat/responses", () => ({
    writeResponseChunk: (res, payload) => {
      res.chunks.push(payload);
      sequence.push(payload.type);
    },
  }));
  jest.doMock("../../endpoints/utils", () => ({ getModelTag: () => "test" }));

  const app = captureApp();
  const { chatEndpoints } = require("../../endpoints/chat");
  chatEndpoints(app);
  return app.routes;
}

describe("native atomic edit stream", () => {
  beforeEach(() => {
    sequence.length = 0;
    jest.clearAllMocks();
    mockTruncateForNativeEdit.mockImplementation(async () => {
      sequence.push("truncate");
      return { success: true, replayed: false, deletedCount: 3 };
    });
    mockRegenerateLastTurn.mockImplementation(async () => {
      sequence.push("regenerate-delete");
      return { success: true, replayed: false, deletedCount: 1 };
    });
    mockWorkspaceChatGet.mockResolvedValue(null);
    mockPublishWorkspaceSyncEvent.mockImplementation((event) => {
      sequence.push(event.type);
      return event;
    });
    mockFlushDurableCommits.mockImplementation(async () => {
      sequence.push("durable");
    });
    mockStreamChatWithWorkspace.mockImplementation(async () => {
      sequence.push("model-context");
    });
  });

  it("opens SSE before truncating and truncates before model context", async () => {
    const routes = loadRoutes();
    const res = response();
    await routes.post["/workspace/:slug/stream-chat"](
      {
        params: { slug: "alpha" },
        body: {
          message: "edited prompt",
          clientTurnId: "turn-1",
          editContext: { startingChatId: 12, sourceActionId: "edit-1" },
        },
      },
      res
    );

    expect(mockTruncateForNativeEdit).toHaveBeenCalledWith({
      workspaceId: 7,
      threadId: null,
      userId: 9,
      startingChatId: 12,
      sourceActionId: "edit-1",
    });
    expect(sequence).toEqual([
      "headers",
      "editSessionReady",
      "truncate",
      "chat_deleted",
      "durable",
      "editHistoryTruncated",
      "chat_prompt_submitted",
      "model-context",
    ]);
  });

  it("leaves ordinary stream requests on the existing path", async () => {
    const routes = loadRoutes();
    const res = response();
    await routes.post["/workspace/:slug/stream-chat"](
      {
        params: { slug: "alpha" },
        body: { message: "ordinary", clientTurnId: "turn-2" },
      },
      res
    );

    expect(mockTruncateForNativeEdit).not.toHaveBeenCalled();
    expect(sequence).toEqual([
      "headers",
      "chat_prompt_submitted",
      "model-context",
    ]);
  });

  it("deletes the latest turn before regeneration enters model context", async () => {
    const routes = loadRoutes();
    const res = response();
    await routes.post["/workspace/:slug/stream-chat"](
      {
        params: { slug: "alpha" },
        body: {
          message: "original prompt",
          clientTurnId: "turn-regenerated",
          regenerateContext: {
            targetChatId: 18,
            sourceActionId: "regenerate-18",
          },
        },
      },
      res
    );

    expect(mockRegenerateLastTurn).toHaveBeenCalledWith({
      workspaceId: 7,
      threadId: null,
      userId: 9,
      targetChatId: 18,
      sourceActionId: "regenerate-18",
    });
    expect(sequence).toEqual([
      "headers",
      "regenerateSessionReady",
      "regenerate-delete",
      "chat_deleted",
      "durable",
      "regenerateTurnDeleted",
      "chat_prompt_submitted",
      "model-context",
    ]);
  });

  it("rejects malformed edit context before opening SSE", async () => {
    const routes = loadRoutes();
    const res = response();
    await routes.post["/workspace/:slug/stream-chat"](
      {
        params: { slug: "alpha" },
        body: {
          message: "edited prompt",
          clientTurnId: "turn-3",
          editContext: { startingChatId: 0, sourceActionId: "edit-3" },
        },
      },
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.jsonPayload.errorCode).toBe("edit_invalid_starting_chat");
    expect(sequence).toEqual([]);
  });

  it("aborts without entering model context when truncation fails", async () => {
    const error = new Error("Unable to truncate history.");
    error.code = "edit_truncate_failed";
    mockTruncateForNativeEdit.mockRejectedValue(error);
    const routes = loadRoutes();
    const res = response();

    await routes.post["/workspace/:slug/stream-chat"](
      {
        params: { slug: "alpha" },
        body: {
          message: "edited prompt",
          clientTurnId: "turn-failed",
          editContext: {
            startingChatId: 12,
            sourceActionId: "edit-failed",
          },
        },
      },
      res
    );

    expect(mockStreamChatWithWorkspace).not.toHaveBeenCalled();
    expect(res.chunks.at(-1)).toMatchObject({
      type: "abort",
      errorCode: "edit_truncate_failed",
    });
    expect(sequence).toEqual([
      "headers",
      "editSessionReady",
      "chat_failed",
      "abort",
    ]);
  });

  it("replays a finalized idempotent turn without invoking the model", async () => {
    mockTruncateForNativeEdit.mockResolvedValue({
      success: true,
      replayed: true,
      deletedCount: 0,
    });
    mockWorkspaceChatGet.mockResolvedValue({
      id: 44,
      public_id: "public-44",
      response: JSON.stringify({ text: "Authoritative reply" }),
    });
    const routes = loadRoutes();
    const res = response();

    await routes.post["/workspace/:slug/stream-chat"](
      {
        params: { slug: "alpha" },
        body: {
          message: "edited prompt",
          clientTurnId: "turn-replayed",
          editContext: {
            startingChatId: 12,
            sourceActionId: "edit-replayed",
          },
        },
      },
      res
    );

    expect(mockStreamChatWithWorkspace).not.toHaveBeenCalled();
    expect(res.chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "fullTextResponse",
          textResponse: "Authoritative reply",
          replayed: true,
        }),
        expect.objectContaining({
          type: "finalizeResponseStream",
          chatId: 44,
          clientTurnId: "turn-replayed",
          replayed: true,
        }),
      ])
    );
  });
});
