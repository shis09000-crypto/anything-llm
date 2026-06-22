const mockWorkspaceWhere = jest.fn();
const mockWorkspaceWhereWithUser = jest.fn();
const mockWorkspaceChatsWhere = jest.fn();
const mockScheduledJobRunWhere = jest.fn();
const mockGetAuthorizedWorkspace = jest.fn();

jest.mock("../../utils/http", () => ({
  multiUserMode: jest.fn(),
  safeJsonParse: (value, fallback) => {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  userFromSession: jest.fn(),
}));

jest.mock("../../utils/middleware/validatedRequest", () => ({
  validatedRequest: jest.fn(),
}));

jest.mock("../../utils/middleware/multiUserProtected", () => ({
  flexUserRoleValid: jest.fn(() => jest.fn()),
  ROLES: { all: "all" },
}));

jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn(async () => {}) },
}));

jest.mock("../../models/workspace", () => ({
  Workspace: {
    where: (...args) => mockWorkspaceWhere(...args),
    whereWithUser: (...args) => mockWorkspaceWhereWithUser(...args),
  },
}));

jest.mock("../../models/workspaceChats", () => ({
  WorkspaceChats: {
    where: (...args) => mockWorkspaceChatsWhere(...args),
  },
}));

jest.mock("../../models/scheduledJobRun", () => ({
  ScheduledJobRun: {
    where: (...args) => mockScheduledJobRunWhere(...args),
  },
}));

jest.mock("../../utils/authz/resourceAccess", () => ({
  getAuthorizedWorkspace: (...args) => mockGetAuthorizedWorkspace(...args),
}));

jest.mock("../../utils/agents/aibitat/plugins/create-files/lib", () => ({
  parseFilename: jest.fn(),
  getGeneratedFile: jest.fn(),
  getMimeType: jest.fn(),
  sanitizeFilenameForHeader: jest.fn(),
}));

describe("agent generated file source authorization", () => {
  let findFileSource;

  beforeEach(() => {
    jest.clearAllMocks();
    findFileSource = require("../../endpoints/agentFileServer")._private
      .findFileSource;
    mockWorkspaceWhereWithUser.mockResolvedValue([{ id: 22 }]);
    mockWorkspaceWhere.mockResolvedValue([{ id: 22 }]);
    mockWorkspaceChatsWhere.mockResolvedValue([
      {
        workspaceId: 22,
        response: JSON.stringify({
          outputs: [
            {
              payload: {
                storageFilename: "deck-abc.pptx",
                filename: "deck.pptx",
              },
            },
          ],
        }),
      },
    ]);
    mockScheduledJobRunWhere.mockResolvedValue([]);
    mockGetAuthorizedWorkspace.mockResolvedValue({ id: 22 });
  });

  it("requires unified workspace authorization for chat-backed files", async () => {
    const source = await findFileSource("deck-abc.pptx", {
      request: {},
      response: {},
      user: { id: 10 },
      isMultiUser: true,
    });

    expect(source).toEqual({
      workspaceId: 22,
      displayFilename: "deck.pptx",
    });
    expect(mockGetAuthorizedWorkspace).toHaveBeenCalledWith({
      request: {},
      response: {},
      workspaceId: 22,
    });
  });

  it("hides chat-backed files when workspace authorization fails", async () => {
    mockGetAuthorizedWorkspace.mockResolvedValue(null);

    await expect(
      findFileSource("deck-abc.pptx", {
        request: {},
        response: {},
        user: { id: 11 },
        isMultiUser: true,
      })
    ).resolves.toBeNull();
  });

  it("keeps scheduled job fallback single-user only", async () => {
    mockWorkspaceChatsWhere.mockResolvedValue([]);
    mockScheduledJobRunWhere.mockResolvedValue([
      {
        result: JSON.stringify({
          outputs: [
            {
              payload: {
                storageFilename: "report.pdf",
                filename: "report.pdf",
              },
            },
          ],
        }),
      },
    ]);

    await expect(
      findFileSource("report.pdf", {
        request: {},
        response: {},
        user: null,
        isMultiUser: true,
      })
    ).resolves.toBeNull();

    await expect(
      findFileSource("report.pdf", {
        request: {},
        response: {},
        user: null,
        isMultiUser: false,
      })
    ).resolves.toEqual({
      workspaceId: null,
      displayFilename: "report.pdf",
    });
  });
});
