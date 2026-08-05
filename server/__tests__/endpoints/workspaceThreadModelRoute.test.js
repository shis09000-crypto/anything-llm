const mockThreadUpdate = jest.fn();
const mockThreadDelete = jest.fn();
const mockThreadNew = jest.fn();
const mockPublishWorkspaceSyncEvent = jest.fn();

jest.mock("../../repositories/telemetryRepository", () => ({
  TelemetryRepository: { sendTelemetry: jest.fn() },
}));
jest.mock("../../repositories/eventLogRepository", () => ({
  EventLogRepository: { logEvent: jest.fn() },
}));

jest.mock("../../models/workspaceThread", () => ({
  WorkspaceThread: {
    THREAD_TYPES: { chat: "chat", overview: "overview" },
    new: (...args) => mockThreadNew(...args),
    update: (...args) => mockThreadUpdate(...args),
    delete: (...args) => mockThreadDelete(...args),
    isOverviewThread: (thread) => thread?.thread_type === "overview",
  },
}));

jest.mock("../../utils/authz/resourceAccess", () => ({
  getAuthorizedWorkspaceThread: async ({ response }) => ({
    workspace: response.locals.workspace,
    thread: response.locals.thread,
  }),
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
    delete: (path, _middleware, handler) => {
      routes[path] = handler;
    },
  };
  const {
    workspaceThreadEndpoints,
  } = require("../../endpoints/workspaceThreads");
  workspaceThreadEndpoints(app);
  return routes["/workspace/:slug/thread/:threadSlug/update"];
}

function newRoute() {
  const routes = {};
  const app = {
    post: (path, _middleware, handler) => {
      routes[path] = handler;
    },
    get: jest.fn(),
    delete: jest.fn(),
  };
  const {
    workspaceThreadEndpoints,
  } = require("../../endpoints/workspaceThreads");
  workspaceThreadEndpoints(app);
  return routes["/workspace/:slug/thread/new"];
}

function deleteRoute() {
  const routes = {};
  const app = {
    post: jest.fn(),
    get: jest.fn(),
    delete: (path, _middleware, handler) => {
      routes[path] = handler;
    },
  };
  const {
    workspaceThreadEndpoints,
  } = require("../../endpoints/workspaceThreads");
  workspaceThreadEndpoints(app);
  return routes["/workspace/:slug/thread/:threadSlug"];
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

  it("returns a JSON success contract after deleting a thread", async () => {
    mockThreadDelete.mockResolvedValue(undefined);
    const route = deleteRoute();
    const res = response();
    const request = {
      params: { slug: "alpha", threadSlug: "thread-a" },
      body: {},
    };

    await route(request, res);

    expect(mockThreadDelete).toHaveBeenCalledWith({ id: 11 });
    expect(mockPublishWorkspaceSyncEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread_deleted",
        threadSlug: "thread-a",
      })
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.status.mock.results[0].value.json).toHaveBeenCalledWith({
      success: true,
      sourceActionId: null,
      threadSlug: "thread-a",
    });
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

  it("locks the visible model into a newly created thread", async () => {
    mockThreadNew.mockResolvedValue({
      thread: {
        id: 12,
        slug: "thread-new",
        name: "New Thread",
        thread_type: "chat",
        chatModel: "deepseek-v4-flash",
        isUntitled: true,
      },
      message: null,
    });
    const route = newRoute();
    const res = response();

    await route(
      {
        body: { chatModel: "deepseek-v4-flash" },
        headers: {},
      },
      res
    );

    expect(mockThreadNew).toHaveBeenCalledWith(
      res.locals.workspace,
      7,
      expect.objectContaining({
        thread_type: "chat",
        chatModel: "deepseek-v4-flash",
      })
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
