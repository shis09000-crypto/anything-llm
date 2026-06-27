const mockWorkspaceChatsWhere = jest.fn();
const mockWorkspaceChatsCount = jest.fn();
const mockForWorkspace = jest.fn();
const mockForWorkspaceByUser = jest.fn();
const mockForWorkspaceByApiSessionId = jest.fn();
const mockWorkspaceGet = jest.fn();
const mockWorkspaceGetWithUser = jest.fn();
const mockWorkspaceThreadGet = jest.fn();
const mockUserFromSession = jest.fn();
const mockQueryParams = jest.fn();
const mockMultiUserMode = jest.fn();

jest.mock("../../models/workspaceChats", () => ({
  WorkspaceChats: {
    where: (...args) => mockWorkspaceChatsWhere(...args),
    count: (...args) => mockWorkspaceChatsCount(...args),
    forWorkspace: (...args) => mockForWorkspace(...args),
    forWorkspaceByUser: (...args) => mockForWorkspaceByUser(...args),
    forWorkspaceByApiSessionId: (...args) =>
      mockForWorkspaceByApiSessionId(...args),
  },
}));

jest.mock("../../models/workspace", () => ({
  Workspace: {
    get: (...args) => mockWorkspaceGet(...args),
    getWithUser: (...args) => mockWorkspaceGetWithUser(...args),
    orderWorkspaces: jest.fn(),
    isAgentCommandAvailable: jest.fn(),
  },
}));

jest.mock("../../models/workspaceThread", () => ({
  WorkspaceThread: {
    get: (...args) => mockWorkspaceThreadGet(...args),
  },
}));

jest.mock("../../utils/http", () => {
  const actual = jest.requireActual("../../utils/http");
  return {
    ...actual,
    userFromSession: (...args) => mockUserFromSession(...args),
    queryParams: (...args) => mockQueryParams(...args),
    multiUserMode: (...args) => mockMultiUserMode(...args),
    reqBody: (request) => request.body || {},
  };
});

jest.mock("../../utils/middleware/validatedRequest", () => ({
  validatedRequest: (_request, _response, next) => next?.(),
}));

jest.mock("../../utils/middleware/validApiKey", () => ({
  validApiKey: (_request, _response, next) => next?.(),
}));

jest.mock("../../utils/chats/stream", () => ({
  VALID_CHAT_MODE: {
    chat: "chat",
    query: "query",
  },
}));

jest.mock("../../utils/helpers", () => ({
  getVectorDbClass: jest.fn(),
  getLLMProvider: jest.fn(),
}));

jest.mock("../../endpoints/workspacesParsedFiles", () => ({
  workspaceParsedFilesEndpoints: jest.fn(),
}));

jest.mock("../../endpoints/workspaceReaderDocuments", () => ({
  workspaceReaderDocumentsEndpoints: jest.fn(),
}));

function chat(id) {
  return {
    id,
    prompt: `prompt ${id}`,
    response: JSON.stringify({ text: `answer ${id}`, sources: [] }),
    createdAt: Date.now() + id,
  };
}

function jsonResponse(locals = {}) {
  const json = jest.fn();
  return {
    locals,
    status: jest.fn(() => ({ json })),
    sendStatus: jest.fn(() => ({ end: jest.fn() })),
  };
}

function routesFor(register) {
  const routes = {};
  const app = {
    get: (path, _middleware, handler) => {
      routes[`GET ${path}`] = handler;
    },
    post: (path, _middleware, handler) => {
      routes[`POST ${path}`] = handler;
    },
    delete: jest.fn(),
    put: jest.fn(),
  };
  register(app);
  return routes;
}

describe("workspace chat history ordering", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.STORAGE_DIR = "/tmp/anythingllm-test-storage";
    mockUserFromSession.mockResolvedValue({ id: 7 });
    mockQueryParams.mockReturnValue({});
    mockMultiUserMode.mockReturnValue(false);
    mockWorkspaceChatsCount.mockResolvedValue(0);
    mockWorkspaceGet.mockResolvedValue({ id: 1, slug: "workspace" });
    mockWorkspaceGetWithUser.mockResolvedValue({ id: 1, slug: "workspace" });
    mockWorkspaceThreadGet.mockResolvedValue({
      id: 4,
      slug: "thread",
      workspace_id: 1,
    });
  });

  it("returns thread history pages in ascending chatId order after descending cursor lookup", async () => {
    const {
      workspaceThreadEndpoints,
    } = require("../../endpoints/workspaceThreads");
    const routes = routesFor(workspaceThreadEndpoints);
    const route = routes["GET /workspace/:slug/thread/:threadSlug/chats"];
    mockQueryParams.mockReturnValue({
      limit: "2",
      beforeChatId: "10",
      detail: "full",
    });
    mockWorkspaceChatsWhere.mockResolvedValue([chat(9), chat(7)]);

    const res = jsonResponse({
      workspace: { id: 1, slug: "workspace" },
      thread: { id: 4, slug: "thread" },
    });
    await route({ params: { slug: "workspace", threadSlug: "thread" } }, res);

    expect(mockWorkspaceChatsWhere).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 1,
        thread_id: 4,
        id: { lt: 10 },
      }),
      2,
      { id: "desc" }
    );
    expect(res.status.mock.results[0].value.json).toHaveBeenCalledWith(
      expect.objectContaining({
        history: expect.arrayContaining([
          expect.objectContaining({ chatId: 7, role: "user" }),
          expect.objectContaining({ chatId: 9, role: "user" }),
        ]),
      })
    );
    const history =
      res.status.mock.results[0].value.json.mock.calls[0][0].history;
    expect(
      history.map((message) => `${message.chatId}:${message.role}`)
    ).toEqual(["7:user", "7:assistant", "9:user", "9:assistant"]);
  });

  it("returns a thread anchor window around the requested chatId", async () => {
    const {
      workspaceThreadEndpoints,
    } = require("../../endpoints/workspaceThreads");
    const routes = routesFor(workspaceThreadEndpoints);
    const route = routes["GET /workspace/:slug/thread/:threadSlug/chats"];
    mockQueryParams.mockReturnValue({
      limit: "5",
      anchorChatId: "10",
      detail: "full",
    });
    mockWorkspaceChatsWhere
      .mockResolvedValueOnce([chat(10)])
      .mockResolvedValueOnce([chat(9), chat(8)])
      .mockResolvedValueOnce([chat(11), chat(12)]);
    mockWorkspaceChatsCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    const res = jsonResponse({
      workspace: { id: 1, slug: "workspace" },
      thread: { id: 4, slug: "thread" },
    });
    await route({ params: { slug: "workspace", threadSlug: "thread" } }, res);

    expect(mockWorkspaceChatsWhere).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceId: 1,
        thread_id: 4,
        id: 10,
      }),
      1,
      { id: "asc" }
    );
    expect(mockWorkspaceChatsWhere).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: { lt: 10 } }),
      2,
      { id: "desc" }
    );
    expect(mockWorkspaceChatsWhere).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ id: { gt: 10 } }),
      2,
      { id: "asc" }
    );

    const payload = res.status.mock.results[0].value.json.mock.calls[0][0];
    expect(payload.page).toEqual(
      expect.objectContaining({
        anchorChatId: 10,
        anchorFound: true,
        nextBeforeChatId: 8,
        olderBeforeChatId: 8,
        nextAfterChatId: 12,
        newerAfterChatId: 12,
        hasOlder: false,
        hasNewer: true,
      })
    );
    expect(
      payload.history.map((message) => `${message.chatId}:${message.role}`)
    ).toEqual([
      "8:user",
      "8:assistant",
      "9:user",
      "9:assistant",
      "10:user",
      "10:assistant",
      "11:user",
      "11:assistant",
      "12:user",
      "12:assistant",
    ]);
  });

  it("reports a missing thread anchor without falling back inside the endpoint", async () => {
    const {
      workspaceThreadEndpoints,
    } = require("../../endpoints/workspaceThreads");
    const routes = routesFor(workspaceThreadEndpoints);
    const route = routes["GET /workspace/:slug/thread/:threadSlug/chats"];
    mockQueryParams.mockReturnValue({
      limit: "5",
      anchorChatId: "999",
      detail: "full",
    });
    mockWorkspaceChatsWhere.mockResolvedValueOnce([]);

    const res = jsonResponse({
      workspace: { id: 1, slug: "workspace" },
      thread: { id: 4, slug: "thread" },
    });
    await route({ params: { slug: "workspace", threadSlug: "thread" } }, res);

    const payload = res.status.mock.results[0].value.json.mock.calls[0][0];
    expect(payload.history).toEqual([]);
    expect(payload.page).toEqual(
      expect.objectContaining({
        anchorChatId: 999,
        anchorFound: false,
        hasOlder: false,
        hasNewer: false,
      })
    );
  });

  it("hydrates thread history with an explicit ascending id order", async () => {
    const {
      workspaceThreadEndpoints,
    } = require("../../endpoints/workspaceThreads");
    const routes = routesFor(workspaceThreadEndpoints);
    const route =
      routes["POST /workspace/:slug/thread/:threadSlug/chats/hydrate"];
    mockWorkspaceChatsWhere.mockResolvedValue([chat(7), chat(9)]);

    const res = jsonResponse({
      workspace: { id: 1, slug: "workspace" },
      thread: { id: 4, slug: "thread" },
    });
    await route(
      {
        params: { slug: "workspace", threadSlug: "thread" },
        body: { chatIds: [9, 7] },
      },
      res
    );

    expect(mockWorkspaceChatsWhere).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 1,
        thread_id: 4,
        id: { in: [9, 7] },
      }),
      null,
      { id: "asc" }
    );
  });

  it("returns default workspace history pages in ascending chatId order", async () => {
    const { workspaceEndpoints } = require("../../endpoints/workspaces");
    const routes = routesFor(workspaceEndpoints);
    const route = routes["GET /workspace/:slug/chats"];
    mockQueryParams.mockReturnValue({ limit: "2", beforeChatId: "10" });
    mockWorkspaceChatsWhere.mockResolvedValue([chat(8), chat(6)]);

    const res = jsonResponse();
    await route({ params: { slug: "workspace" } }, res);

    expect(mockWorkspaceChatsWhere).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 1,
        thread_id: null,
        id: { lt: 10 },
      }),
      2,
      { id: "desc" }
    );
    const history =
      res.status.mock.results[0].value.json.mock.calls[0][0].history;
    expect(
      history.map((message) => `${message.chatId}:${message.role}`)
    ).toEqual(["6:user", "6:assistant", "8:user", "8:assistant"]);
  });

  it("uses id ordering for developer API workspace history", async () => {
    const { apiWorkspaceEndpoints } = require("../../endpoints/api/workspace");
    const routes = routesFor(apiWorkspaceEndpoints);
    const route = routes["GET /v1/workspace/:slug/chats"];
    mockForWorkspace.mockResolvedValue([chat(1)]);

    const res = jsonResponse();
    await route(
      { params: { slug: "workspace" }, query: { limit: "20", orderBy: "asc" } },
      res
    );

    expect(mockForWorkspace).toHaveBeenCalledWith(1, 20, { id: "asc" });
  });

  it("uses explicit ascending id order for developer API thread history", async () => {
    const {
      apiWorkspaceThreadEndpoints,
    } = require("../../endpoints/api/workspaceThread");
    const routes = routesFor(apiWorkspaceThreadEndpoints);
    const route = routes["GET /v1/workspace/:slug/thread/:threadSlug/chats"];
    mockWorkspaceChatsWhere.mockResolvedValue([chat(3), chat(4)]);

    const res = jsonResponse();
    await route(
      { params: { slug: "workspace", threadSlug: "thread" }, query: {} },
      res
    );

    expect(mockWorkspaceChatsWhere).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 1,
        thread_id: 4,
        api_session_id: null,
        include: true,
      }),
      null,
      { id: "asc" }
    );
  });
});
