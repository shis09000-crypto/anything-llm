const mockWorkspaceGet = jest.fn();
const mockThreadGet = jest.fn();
const mockUserGet = jest.fn();
const mockCompactThread = jest.fn();
const originalEnv = { ...process.env };

jest.mock("../../models/workspace", () => ({
  Workspace: { get: mockWorkspaceGet },
}));

jest.mock("../../models/workspaceThread", () => ({
  WorkspaceThread: {
    get: mockThreadGet,
  },
}));

jest.mock("../../models/user", () => ({
  User: { get: mockUserGet },
}));

jest.mock("../../utils/chats/threadCompaction", () => ({
  compactThread: mockCompactThread,
}));

jest.mock("../../utils/chats/stream", () => ({
  VALID_CHAT_MODE: {
    chat: "chat",
    query: "query",
  },
}));

jest.mock("../../utils/middleware/validApiKey", () => ({
  validApiKey: (_request, _response, next) => next(),
}));

describe("Developer API thread compaction route", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      STORAGE_DIR: "/tmp/anythingllm-thread-compaction-route-test",
    };
    mockWorkspaceGet.mockResolvedValue({ id: 1, slug: "workspace" });
    mockThreadGet.mockResolvedValue({
      id: 42,
      slug: "thread-slug",
      user_id: 7,
    });
    mockUserGet.mockResolvedValue({ id: 7 });
    mockCompactThread.mockResolvedValue({
      success: true,
      compactionId: 9,
      coveredMessageCount: 3,
      tokenBefore: 30,
      tokenAfter: 10,
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("resolves threadSlug to internal thread.id before compacting", async () => {
    const routes = {};
    const app = {
      post: (path, _middleware, handler) => {
        routes[path] = handler;
      },
      delete: jest.fn(),
      get: jest.fn(),
    };
    const { apiWorkspaceThreadEndpoints } = require("../../endpoints/api/workspaceThread");
    apiWorkspaceThreadEndpoints(app);

    const json = jest.fn();
    await routes["/v1/workspace/:slug/thread/:threadSlug/compact"](
      {
        params: { slug: "workspace", threadSlug: "thread-slug" },
        body: { userId: 7, apiSessionId: "api-1", force: true },
      },
      {
        status: jest.fn(() => ({ json })),
      }
    );

    expect(mockThreadGet).toHaveBeenCalledWith({
      slug: "thread-slug",
      workspace_id: 1,
    });
    expect(mockCompactThread).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: { id: 1, slug: "workspace" },
        user: { id: 7 },
        thread: { id: 42, slug: "thread-slug", user_id: 7 },
        apiSessionId: "api-1",
        force: true,
      })
    );
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        compactionId: 9,
      })
    );
  });

  it("defaults compaction user scope to the thread owner", async () => {
    const routes = {};
    const app = {
      post: (path, _middleware, handler) => {
        routes[path] = handler;
      },
      delete: jest.fn(),
      get: jest.fn(),
    };
    const { apiWorkspaceThreadEndpoints } = require("../../endpoints/api/workspaceThread");
    apiWorkspaceThreadEndpoints(app);

    const json = jest.fn();
    await routes["/v1/workspace/:slug/thread/:threadSlug/compact"](
      {
        params: { slug: "workspace", threadSlug: "thread-slug" },
        body: { apiSessionId: "api-1" },
      },
      {
        status: jest.fn(() => ({ json })),
      }
    );

    expect(mockUserGet).toHaveBeenCalledWith({ id: 7 });
    expect(mockCompactThread).toHaveBeenCalledWith(
      expect.objectContaining({
        user: { id: 7 },
        thread: expect.objectContaining({ user_id: 7 }),
      })
    );
  });

  it("rejects compaction when requested userId does not own the thread", async () => {
    const routes = {};
    const app = {
      post: (path, _middleware, handler) => {
        routes[path] = handler;
      },
      delete: jest.fn(),
      get: jest.fn(),
    };
    const { apiWorkspaceThreadEndpoints } = require("../../endpoints/api/workspaceThread");
    apiWorkspaceThreadEndpoints(app);

    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    await routes["/v1/workspace/:slug/thread/:threadSlug/compact"](
      {
        params: { slug: "workspace", threadSlug: "thread-slug" },
        body: { userId: 8, apiSessionId: "api-1" },
      },
      { status }
    );

    expect(status).toHaveBeenCalledWith(404);
    expect(mockCompactThread).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        compactionId: null,
      })
    );
  });
});
