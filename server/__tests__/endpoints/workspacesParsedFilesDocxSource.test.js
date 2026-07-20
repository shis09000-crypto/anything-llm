/* global jest, describe, beforeEach, it, expect */
const mockParseDocument = jest.fn();
const mockParsedFileCreate = jest.fn();
const mockSaveDocxSource = jest.fn();
const mockDeleteDocxSource = jest.fn();

jest.mock("../../utils/http", () => ({
  reqBody: (request) => request.body || {},
  multiUserMode: () => true,
  userFromSession: jest.fn().mockResolvedValue({ id: 9 }),
}));
jest.mock("../../utils/files/multer", () => ({
  handleFileUpload: (_request, _response, next) => next?.(),
}));
jest.mock("../../utils/middleware/validatedRequest", () => ({
  validatedRequest: (_request, _response, next) => next?.(),
}));
jest.mock("../../utils/middleware/multiUserProtected", () => ({
  flexUserRoleValid: () => (_request, _response, next) => next?.(),
  ROLES: { all: "all" },
}));
jest.mock("../../utils/middleware/validWorkspace", () => ({
  validWorkspaceSlug: (_request, response, next) => {
    response.locals.workspace = { id: 7, slug: "workspace-a" };
    next?.();
  },
}));
jest.mock("../../utils/collectorApi", () => ({
  CollectorApi: jest.fn().mockImplementation(() => ({
    online: jest.fn().mockResolvedValue(true),
    parseDocument: (...args) => mockParseDocument(...args),
    log: jest.fn(),
  })),
}));
jest.mock("../../utils/dataAccess", () => ({
  DataAccessCenter: {
    workspaceParsedFile: {
      create: (...args) => mockParsedFileCreate(...args),
      delete: jest.fn(),
      getContextMetadataAndLimits: jest.fn(),
      moveToDocumentsAndEmbed: jest.fn(),
    },
    workspaceThread: { get: jest.fn().mockResolvedValue(null) },
  },
}));
jest.mock("../../utils/documentSources", () => ({
  saveDocxSource: (...args) => mockSaveDocxSource(...args),
  deleteDocxSource: (...args) => mockDeleteDocxSource(...args),
}));
jest.mock("../../repositories/telemetryRepository", () => ({
  TelemetryRepository: { sendTelemetry: jest.fn() },
}));
jest.mock("../../repositories/eventLogRepository", () => ({
  EventLogRepository: { logEvent: jest.fn() },
}));
jest.mock("../../utils/authz/resourceAccess", () => ({
  getAuthorizedParsedFile: jest.fn(),
}));

function captureParseRoute() {
  const routes = {};
  const app = {
    get: jest.fn(),
    delete: jest.fn(),
    post: (route, _middleware, handler) => {
      routes[route] = handler;
    },
  };
  const {
    workspaceParsedFilesEndpoints,
  } = require("../../endpoints/workspacesParsedFiles");
  workspaceParsedFilesEndpoints(app);
  return routes["/workspace/:slug/parse"];
}

function response() {
  const output = {
    locals: { workspace: { id: 7, slug: "workspace-a" } },
    status: jest.fn(function () {
      return output;
    }),
    json: jest.fn(function () {
      return output;
    }),
    sendStatus: jest.fn(function () {
      return output;
    }),
    end: jest.fn(function () {
      return output;
    }),
  };
  return output;
}

describe("workspace DOCX source retention", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSaveDocxSource.mockReturnValue(
      "11111111-1111-4111-8111-111111111111.docx"
    );
    mockParseDocument.mockResolvedValue({
      success: true,
      documents: [
        {
          id: "parsed-1",
          title: "项目报告.docx",
          location: "direct-uploads/report.json",
          pageContent: "正文",
        },
      ],
    });
    mockParsedFileCreate.mockResolvedValue({
      file: { id: 22 },
      error: null,
    });
  });

  it("stores an opaque source reference in parsed-file metadata", async () => {
    const handler = captureParseRoute();
    const res = response();
    await handler(
      {
        body: {},
        file: {
          path: "/collector/hotdir/upload.docx",
          filename: "isolated-upload.docx",
          originalname: "项目报告.docx",
        },
      },
      res
    );

    expect(mockSaveDocxSource).toHaveBeenCalledWith(
      "/collector/hotdir/upload.docx"
    );
    expect(mockParsedFileCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 7,
        userId: 9,
        metadata: expect.any(String),
      })
    );
    const metadata = JSON.parse(mockParsedFileCreate.mock.calls[0][0].metadata);
    expect(metadata.pageContent).toBeUndefined();
    expect(metadata.docxSource).toEqual({
      token: "11111111-1111-4111-8111-111111111111.docx",
      originalName: "项目报告.docx",
    });
    expect(mockDeleteDocxSource).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("deletes the retained source when document parsing fails", async () => {
    mockParseDocument.mockResolvedValue({
      success: false,
      reason: "parse_failed",
      documents: [],
    });
    const handler = captureParseRoute();
    const res = response();
    await handler(
      {
        body: {},
        file: {
          path: "/collector/hotdir/upload.docx",
          filename: "isolated-upload.docx",
          originalname: "项目报告.docx",
        },
      },
      res
    );

    expect(mockDeleteDocxSource).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111.docx"
    );
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
