const mockWorkspaceGet = jest.fn();
const mockWorkspaceGetWithUser = jest.fn();
const mockMoveToWorkspace = jest.fn();
const mockConnectorGetByThreadSlug = jest.fn();
const mockLogEvent = jest.fn();

jest.mock("../../models/workspace", () => ({
  Workspace: {
    get: (...args) => mockWorkspaceGet(...args),
    getWithUser: (...args) => mockWorkspaceGetWithUser(...args),
  },
}));

jest.mock("../../models/workspaceThread", () => ({
  WorkspaceThread: {
    THREAD_TYPES: { chat: "chat", overview: "overview" },
    isOverviewThread: (thread = null) => thread?.thread_type === "overview",
    moveToWorkspace: (...args) => mockMoveToWorkspace(...args),
  },
}));

jest.mock("../../models/wechatGatewayThread", () => ({
  WeChatGatewayThread: {
    getByThreadSlug: (...args) => mockConnectorGetByThreadSlug(...args),
  },
}));

jest.mock("../../models/eventLogs", () => ({
  EventLogs: {
    logEvent: (...args) => mockLogEvent(...args),
  },
}));

jest.mock("../../utils/middleware/validatedRequest", () => ({
  validatedRequest: (_request, _response, next) => next?.(),
}));

function moveRoute() {
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
  return routes["/workspace/:slug/thread/:threadSlug/move"];
}

function response({
  workspace = { id: 1, slug: "source", name: "Source" },
  thread = {
    id: 7,
    slug: "thread-slug",
    name: "Thread",
    workspace_id: 1,
    user_id: 2,
    thread_type: "chat",
  },
  user = { id: 2, role: "default" },
  multiUserMode = false,
} = {}) {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const sendStatus = jest.fn(() => ({ end: jest.fn() }));
  return {
    locals: { workspace, thread, user, multiUserMode },
    status,
    json,
    sendStatus,
  };
}

describe("workspace thread move route", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockWorkspaceGet.mockResolvedValue({
      id: 2,
      slug: "target",
      name: "Target",
    });
    mockWorkspaceGetWithUser.mockResolvedValue({
      id: 2,
      slug: "target",
      name: "Target",
    });
    mockConnectorGetByThreadSlug.mockResolvedValue(null);
    mockMoveToWorkspace.mockResolvedValue({
      thread: {
        id: 7,
        slug: "thread-slug",
        name: "Thread",
        workspace_id: 2,
      },
      message: null,
      movedChatCount: 2,
    });
    mockLogEvent.mockResolvedValue();
  });

  it("moves a thread to an accessible target workspace", async () => {
    const route = moveRoute();
    const res = response();

    await route({ body: { targetWorkspaceSlug: "target" } }, res);

    expect(mockWorkspaceGet).toHaveBeenCalledWith({ slug: "target" });
    expect(mockMoveToWorkspace).toHaveBeenCalledWith({
      thread: res.locals.thread,
      sourceWorkspace: res.locals.workspace,
      targetWorkspace: { id: 2, slug: "target", name: "Target" },
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.status.mock.results[0].value.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        sourceWorkspaceSlug: "source",
        targetWorkspaceSlug: "target",
        movedChatCount: 2,
      })
    );
  });

  it("rejects same-workspace moves", async () => {
    const route = moveRoute();
    const res = response();

    await route({ body: { targetWorkspaceSlug: "source" } }, res);

    expect(mockMoveToWorkspace).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.status.mock.results[0].value.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false })
    );
  });

  it("rejects overview threads", async () => {
    const route = moveRoute();
    const res = response({
      thread: {
        id: 8,
        slug: "overview",
        workspace_id: 1,
        user_id: 2,
        thread_type: "overview",
      },
    });

    await route({ body: { targetWorkspaceSlug: "target" } }, res);

    expect(mockMoveToWorkspace).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects inaccessible target workspaces", async () => {
    mockWorkspaceGetWithUser.mockResolvedValue(null);
    const route = moveRoute();
    const res = response({ multiUserMode: true });

    await route({ body: { targetWorkspaceSlug: "target" } }, res);

    expect(mockWorkspaceGetWithUser).toHaveBeenCalledWith(res.locals.user, {
      slug: "target",
    });
    expect(mockMoveToWorkspace).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("rejects threads that do not belong to the source workspace", async () => {
    const route = moveRoute();
    const res = response({
      thread: {
        id: 7,
        slug: "thread-slug",
        workspace_id: 999,
        user_id: 2,
        thread_type: "chat",
      },
    });

    await route({ body: { targetWorkspaceSlug: "target" } }, res);

    expect(mockMoveToWorkspace).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("rejects connector-managed threads", async () => {
    mockConnectorGetByThreadSlug.mockResolvedValue({
      workspace_slug: "source",
      thread_slug: "thread-slug",
    });
    const route = moveRoute();
    const res = response();

    await route({ body: { targetWorkspaceSlug: "target" } }, res);

    expect(mockMoveToWorkspace).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
