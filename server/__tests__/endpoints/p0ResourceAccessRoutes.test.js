const mockDocumentIndexWhere = jest.fn();
const mockGetAuthorizedWorkspace = jest.fn();
const mockGetAuthorizedParsedFile = jest.fn();
const mockGetAuthorizedAgentInvocation = jest.fn();
const mockMoveToDocumentsAndEmbed = jest.fn();
const mockParsedFileDelete = jest.fn();
const mockSendTelemetry = jest.fn();
const mockLogEvent = jest.fn();
const mockGetAgentSessionState = jest.fn();
const mockAgentHandlerInit = jest.fn();

function captureApp() {
  const routes = { get: {}, patch: {}, post: {}, ws: {} };
  return {
    routes,
    get: (path, _middleware, handler) => {
      routes.get[path] = handler;
    },
    patch: (path, _middleware, handler) => {
      routes.patch[path] = handler;
    },
    post: (path, _middleware, handler) => {
      routes.post[path] = handler;
    },
    delete: jest.fn(),
    ws: (path, handler) => {
      routes.ws[path] = handler;
    },
  };
}

function response(locals = {}) {
  const res = {
    locals,
    status: jest.fn(function () {
      return res;
    }),
    json: jest.fn(function () {
      return res;
    }),
    sendStatus: jest.fn(function () {
      return res;
    }),
    end: jest.fn(function () {
      return res;
    }),
  };
  return res;
}

function loadDocumentIndexStatusRoute() {
  jest.resetModules();
  jest.doMock("../../models/documents", () => ({
    Document: { get: jest.fn() },
  }));
  jest.doMock("../../models/documentIndexStatus", () => ({
    DocumentIndexStatus: { where: (...args) => mockDocumentIndexWhere(...args) },
  }));
  jest.doMock("../../utils/files", () => ({
    normalizePath: (value) => value,
    documentsPath: "/tmp/documents",
    isWithin: () => true,
  }));
  jest.doMock("../../utils/http", () => ({
    reqBody: (request) => request.body || {},
    multiUserMode: () => true,
    userFromSession: jest.fn(),
  }));
  jest.doMock("../../utils/middleware/multiUserProtected", () => ({
    flexUserRoleValid: () => (_request, _response, next) => next?.(),
    ROLES: { all: "all", admin: "admin" },
  }));
  jest.doMock("../../utils/middleware/validatedRequest", () => ({
    validatedRequest: (_request, _response, next) => next?.(),
  }));
  jest.doMock("../../utils/authz/resourceAccess", () => ({
    getAuthorizedWorkspace: (...args) => mockGetAuthorizedWorkspace(...args),
  }));

  const app = captureApp();
  const { documentEndpoints } = require("../../endpoints/document");
  documentEndpoints(app);
  return app.routes.get["/document/index-status"];
}

function loadParsedEmbedRoute() {
  jest.resetModules();
  jest.doMock("../../utils/http", () => ({
    reqBody: (request) => request.body || {},
    multiUserMode: () => true,
    userFromSession: () => Promise.resolve({ id: 10 }),
  }));
  jest.doMock("../../utils/files/multer", () => ({
    handleFileUpload: (_request, _response, next) => next?.(),
  }));
  jest.doMock("../../utils/middleware/validatedRequest", () => ({
    validatedRequest: (_request, _response, next) => next?.(),
  }));
  jest.doMock("../../utils/middleware/multiUserProtected", () => ({
    flexUserRoleValid: () => (_request, _response, next) => next?.(),
    ROLES: { all: "all" },
  }));
  jest.doMock("../../utils/middleware/validWorkspace", () => ({
    validWorkspaceSlug: (_request, res, next) => {
      res.locals.workspace = { id: 22, slug: "workspace-a" };
      next?.();
    },
  }));
  jest.doMock("../../models/telemetry", () => ({
    Telemetry: { sendTelemetry: (...args) => mockSendTelemetry(...args) },
  }));
  jest.doMock("../../models/eventLogs", () => ({
    EventLogs: { logEvent: (...args) => mockLogEvent(...args) },
  }));
  jest.doMock("../../models/workspaceThread", () => ({
    WorkspaceThread: { get: jest.fn() },
  }));
  jest.doMock("../../utils/collectorApi", () => ({
    CollectorApi: jest.fn(),
  }));
  jest.doMock("../../models/workspaceParsedFiles", () => ({
    WorkspaceParsedFiles: {
      moveToDocumentsAndEmbed: (...args) =>
        mockMoveToDocumentsAndEmbed(...args),
      delete: (...args) => mockParsedFileDelete(...args),
    },
  }));
  jest.doMock("../../utils/authz/resourceAccess", () => ({
    getAuthorizedParsedFile: (...args) => mockGetAuthorizedParsedFile(...args),
  }));

  const app = captureApp();
  const { workspaceParsedFilesEndpoints } = require("../../endpoints/workspacesParsedFiles");
  workspaceParsedFilesEndpoints(app);
  return app.routes.post["/workspace/:slug/embed-parsed-file/:fileId"];
}

function loadAgentRoutes() {
  jest.resetModules();
  jest.doMock("../../models/telemetry", () => ({
    Telemetry: { sendTelemetry: jest.fn() },
  }));
  jest.doMock("../../models/workspaceAgentInvocation", () => ({
    WorkspaceAgentInvocation: {
      close: jest.fn(),
    },
  }));
  jest.doMock("../../utils/agents", () => ({
    AgentHandler: jest.fn().mockImplementation(() => ({
      init: (...args) => mockAgentHandlerInit(...args),
    })),
  }));
  jest.doMock("../../utils/agents/aibitat/plugins/websocket", () => ({
    WEBSOCKET_BAIL_COMMANDS: ["stop"],
  }));
  jest.doMock("../../utils/http", () => ({
    safeJsonParse: (value, fallback = {}) => {
      try {
        return JSON.parse(value);
      } catch {
        return fallback;
      }
    },
  }));
  jest.doMock("../../utils/chats/agents", () => ({
    clearInvocationFileAccess: jest.fn(),
  }));
  jest.doMock("../../utils/agents/agentSessionLedger", () => ({
    getAgentSessionState: (...args) => mockGetAgentSessionState(...args),
    markAgentSessionState: jest.fn(),
    readAgentSessionEvents: jest.fn(() => []),
    recordAgentSessionEvent: jest.fn(),
  }));
  jest.doMock("../../utils/authz/resourceAccess", () => ({
    getAuthorizedAgentInvocation: (...args) =>
      mockGetAuthorizedAgentInvocation(...args),
  }));
  jest.doMock("../../utils/middleware/validatedRequest", () => ({
    validatedRequest: (_request, _response, next) => next?.(),
  }));

  const app = captureApp();
  const { agentWebsocket } = require("../../endpoints/agentWebsocket");
  agentWebsocket(app);
  return {
    stateRoute: app.routes.get["/agent-invocation/:uuid/state"],
    socketRoute: app.routes.ws["/agent-invocation/:uuid"],
  };
}

describe("P0 resource access route guards", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does not allow document index status without a workspace scope", async () => {
    const route = loadDocumentIndexStatusRoute();
    const res = response();

    await route({ query: {}, body: {} }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockGetAuthorizedWorkspace).not.toHaveBeenCalled();
    expect(mockDocumentIndexWhere).not.toHaveBeenCalled();
  });

  it("hides document index status for inaccessible workspaces", async () => {
    mockGetAuthorizedWorkspace.mockResolvedValue(null);
    const route = loadDocumentIndexStatusRoute();
    const res = response();

    await route({ query: { workspaceId: "22" }, body: {} }, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockDocumentIndexWhere).not.toHaveBeenCalled();
  });

  it("queries document index status only inside the authorized workspace", async () => {
    mockGetAuthorizedWorkspace.mockResolvedValue({ id: 22 });
    mockDocumentIndexWhere.mockResolvedValue([{ id: 1 }]);
    const route = loadDocumentIndexStatusRoute();
    const res = response();

    await route({
      query: { workspaceSlug: "workspace-a", filePath: "doc.md" },
      body: {},
    }, res);

    expect(mockDocumentIndexWhere).toHaveBeenCalledWith({
      workspaceId: 22,
      filePath: "doc.md",
      docId: null,
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("does not embed or delete parsed files without scoped authorization", async () => {
    mockGetAuthorizedParsedFile.mockResolvedValue(null);
    const route = loadParsedEmbedRoute();
    const res = response({ workspace: { id: 22, slug: "workspace-a" } });

    await route({ params: { fileId: "7" }, body: {} }, res);

    expect(res.sendStatus).toHaveBeenCalledWith(404);
    expect(mockMoveToDocumentsAndEmbed).not.toHaveBeenCalled();
    expect(mockParsedFileDelete).not.toHaveBeenCalled();
  });

  it("passes the pre-authorized parsed file into embed processing", async () => {
    const parsedFile = { id: 7, workspaceId: 22, userId: 10 };
    mockGetAuthorizedParsedFile.mockResolvedValue(parsedFile);
    mockMoveToDocumentsAndEmbed.mockResolvedValue({
      success: true,
      error: null,
      document: { name: "doc.md" },
    });
    const route = loadParsedEmbedRoute();
    const res = response({ workspace: { id: 22, slug: "workspace-a" } });

    await route({ params: { fileId: "7" }, body: {} }, res);

    expect(mockMoveToDocumentsAndEmbed).toHaveBeenCalledWith(
      { id: 10 },
      "7",
      { id: 22, slug: "workspace-a" },
      parsedFile
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("hides agent invocation state when the invocation is not authorized", async () => {
    mockGetAuthorizedAgentInvocation.mockResolvedValue(null);
    const { stateRoute } = loadAgentRoutes();
    const res = response();

    await stateRoute({ params: { uuid: "agent-uuid" }, query: {} }, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockGetAgentSessionState).not.toHaveBeenCalled();
  });

  it("rejects unauthorized agent websocket handshakes before agent startup", async () => {
    mockGetAuthorizedAgentInvocation.mockResolvedValue(null);
    const { socketRoute } = loadAgentRoutes();
    const socket = { close: jest.fn(), send: jest.fn(), on: jest.fn() };

    await socketRoute(socket, {
      params: { uuid: "agent-uuid" },
      query: { token: "other-token", resume: "1", lastEventSeq: "4" },
    });

    expect(socket.close).toHaveBeenCalledWith(1008);
    expect(mockAgentHandlerInit).not.toHaveBeenCalled();
  });
});
