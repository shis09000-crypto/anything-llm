/* global jest, describe, beforeEach, it, expect */
const mockParsedFiles = { where: jest.fn() };
const mockDocuments = { where: jest.fn(), content: jest.fn() };
const mockWorkspaceChats = { where: jest.fn() };
const mockReadDocxSource = jest.fn();
const mockGetGeneratedFile = jest.fn();

jest.mock("../../../utils/dataAccess/lazyFacade", () => ({
  lazyDataAccessFacade: jest.fn((domain) =>
    domain === "workspaceParsedFile" ? mockParsedFiles : mockDocuments
  ),
}));
jest.mock("../../../repositories/workspaceChatRepository", () => ({
  WorkspaceChatRepository: mockWorkspaceChats,
}));
jest.mock("../../../utils/documentSources", () => ({
  readDocxSource: mockReadDocxSource,
  sourceTokenFromMetadata: jest.fn(
    (metadata) => JSON.parse(metadata || "{}").docxSource?.token || null
  ),
}));
jest.mock("../../../utils/agents/aibitat/plugins/create-files/lib", () => ({
  getGeneratedFile: mockGetGeneratedFile,
}));

const {
  resolveDocumentSource,
} = require("../../../utils/agents/aibitat/plugins/document-formatting/lib");

function aibitatContext() {
  return {
    handlerProps: {
      fileAccessContext: {
        workspace: { id: 7 },
        user: { id: 9 },
        thread: { id: 11 },
      },
    },
  };
}

describe("DOCX formatting source resolver", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParsedFiles.where.mockResolvedValue([]);
    mockWorkspaceChats.where.mockResolvedValue([]);
    mockDocuments.where.mockResolvedValue([]);
    mockReadDocxSource.mockReturnValue(Buffer.from("authorized source"));
  });

  it("scopes parsed-file resolution to the current workspace, user, and thread", async () => {
    mockParsedFiles.where.mockResolvedValue([
      {
        id: 12,
        filename: "report.docx-parsed.json",
        metadata: JSON.stringify({
          title: "report.docx",
          docxSource: { token: "11111111-1111-4111-8111-111111111111.docx" },
        }),
      },
    ]);

    const source = await resolveDocumentSource(aibitatContext(), "report.docx");
    expect(source.kind).toBe("parsed_file");
    expect(source.buffer).toEqual(Buffer.from("authorized source"));
    expect(mockParsedFiles.where).toHaveBeenCalledWith({
      workspaceId: 7,
      userId: 9,
      threadId: 11,
    });
  });

  it("does not resolve a document that is absent from authorized records", async () => {
    await expect(
      resolveDocumentSource(aibitatContext(), "private.docx")
    ).rejects.toThrow("document_source_not_found");
    expect(mockGetGeneratedFile).not.toHaveBeenCalled();
  });

  it("rejects ambiguous identifiers instead of selecting an arbitrary source", async () => {
    mockParsedFiles.where.mockResolvedValue([
      {
        id: 12,
        filename: "report.docx",
        metadata: JSON.stringify({
          title: "report.docx",
          docxSource: { token: "11111111-1111-4111-8111-111111111111.docx" },
        }),
      },
    ]);
    mockWorkspaceChats.where.mockResolvedValue([
      {
        response: JSON.stringify({
          outputs: [
            {
              payload: {
                filename: "report.docx",
                storageFilename:
                  "docx-22222222-2222-4222-8222-222222222222.docx",
              },
            },
          ],
        }),
      },
    ]);
    mockGetGeneratedFile.mockResolvedValue({
      buffer: Buffer.from("generated source"),
    });

    await expect(
      resolveDocumentSource(aibitatContext(), "report.docx")
    ).rejects.toThrow("ambiguous_document_source");
  });
});
