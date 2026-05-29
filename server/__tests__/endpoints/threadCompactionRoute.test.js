const mockWorkspaceGet = jest.fn();
const mockThreadGet = jest.fn();
const mockUserGet = jest.fn();
const mockCompactThread = jest.fn();

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

jest.mock("../../utils/middleware/validApiKey", () => ({
  validApiKey: (_request, _response, next) => next(),
}));

describe("Developer API thread compaction route", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockWorkspaceGet.mockResolvedValue({ id: 1, slug: "workspace" });
    mockThreadGet.mockResolvedValue({ id: 42, slug: "thread-slug" });
    mockUserGet.mockResolvedValue({ id: 7 });
    mockCompactThread.mockResolvedValue({
      success: true,
      compactionId: 9,
      coveredMessageCount: 3,
      tokenBefore: 30,
      tokenAfter: 10,
    });
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
        thread: { id: 42, slug: "thread-slug" },
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
});
