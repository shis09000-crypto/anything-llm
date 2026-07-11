const mockThreadUpdate = jest.fn();
const mockPublishWorkspaceSyncEvent = jest.fn();

jest.mock("../../models/workspaceThread", () => ({
  WorkspaceThread: {
    THREAD_TYPES: { chat: "chat", overview: "overview" },
    update: (...args) => mockThreadUpdate(...args),
  },
}));

jest.mock("../../utils/middleware/validatedRequest", () => ({
  validatedRequest: (_request, _response, next) => next?.(),
}));

jest.mock("../../utils/chats/workspaceSyncEvents", () => ({
  publishWorkspaceSyncEvent: (...args) =>
    mockPublishWorkspaceSyncEvent(...args),
  subscribeToWorkspaceSyncEvents: jest.fn(() => jest.fn()),
}));

function updateRoute() {
  const routes = {};
  const app = {
    post: (path, _middleware, handler) => {
      routes[path] = handler;
    },
    get: jest.fn(),
    delete: jest.fn(),
  };
  const { workspaceThreadEndpoints } = require("../../endpoints/workspaceThreads");
  workspaceThreadEndpoints(app);
  return routes["/workspace/:slug/thread/:threadSlug/update"];
}

function response() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return {
    locals: {
      workspace: { id: 1, slug: "alpha", name: "Alpha" },
      thread: {
        id: 11,
        slug: "thread-a",
        name: "Thread A",
        workspace_id: 1,
        thread_type: "chat",
      },
      user: { id: 7, role: "default" },
      multiUserMode: true,
    },
    status,
  };
}

describe("workspace thread model update route", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("rejects unsupported model identifiers before writing", async () => {
    const route = updateRoute();
    const res = response();

    await route({ body: { chatModel: "gpt-5" } }, res);

    expect(mockThreadUpdate).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.status.mock.results[0].value.json).toHaveBeenCalledWith({
      thread: null,
      message: "Unsupported thread chat model.",
    });
  });

  it("persists and broadcasts a supported thread model", async () => {
    mockThreadUpdate.mockResolvedValue({
      thread: {
        id: 11,
        slug: "thread-a",
        name: "Thread A",
        thread_type: "chat",
        chatModel: "deepseek-v4-flash",
      },
      message: null,
    });
    const route = updateRoute();
    const res = response();

    await route({ body: { chatModel: "deepseek-v4-flash" } }, res);

    expect(mockThreadUpdate).toHaveBeenCalledWith(res.locals.thread, {
      chatModel: "deepseek-v4-flash",
    });
    expect(mockPublishWorkspaceSyncEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread_updated",
        chatModel: "deepseek-v4-flash",
      })
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
