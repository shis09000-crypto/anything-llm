/* global jest, describe, beforeEach, it, expect */
const mockFormatterLib = {
  formatDocxBuffer: jest.fn(),
  normalizeOutputFilename: jest.fn(),
  rebuildDocxFromContent: jest.fn(),
  resolveDocumentSource: jest.fn(),
};
const mockCreateFilesLib = {
  registerOutput: jest.fn(),
  saveGeneratedFile: jest.fn(),
};

jest.mock(
  "../../../utils/agents/aibitat/plugins/document-formatting/lib",
  () => mockFormatterLib
);
jest.mock(
  "../../../utils/agents/aibitat/plugins/create-files/lib",
  () => mockCreateFilesLib
);

const {
  FormatDocxFile,
} = require("../../../utils/agents/aibitat/plugins/document-formatting");

function setupTool({ approved = true } = {}) {
  let definition = null;
  const aibitat = {
    function: jest.fn((value) => {
      definition = value;
    }),
    handlerProps: { log: jest.fn() },
    requestToolApproval: jest
      .fn()
      .mockResolvedValue(
        approved
          ? { approved: true, message: "approved" }
          : { approved: false, message: "rejected" }
      ),
    socket: { send: jest.fn() },
  };
  FormatDocxFile.plugin().setup(aibitat);
  return { aibitat, definition };
}

describe("format-docx-file agent tool", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFormatterLib.resolveDocumentSource.mockResolvedValue({
      displayName: "source.docx",
      buffer: Buffer.from("source"),
      content: "# Source",
    });
    mockFormatterLib.normalizeOutputFilename.mockReturnValue(
      "formatted-source.docx"
    );
    mockFormatterLib.formatDocxBuffer.mockReturnValue({
      buffer: Buffer.from("formatted"),
      language: "en",
    });
    mockFormatterLib.rebuildDocxFromContent.mockResolvedValue(
      Buffer.from("rebuilt")
    );
    mockCreateFilesLib.saveGeneratedFile.mockResolvedValue({
      displayFilename: "formatted-source.docx",
      filename: "docx-11111111-1111-4111-8111-111111111111.docx",
      fileSize: 9,
    });
  });

  it("registers the documented JSON schema", () => {
    const { definition } = setupTool();
    expect(definition.name).toBe("format-docx-file");
    expect(definition.parameters.required).toEqual(["source"]);
    expect(definition.parameters.additionalProperties).toBe(false);
    expect(definition.parameters.properties.profile.enum).toEqual([
      "professional",
      "academic",
      "minimal",
    ]);
    expect(definition.parameters.properties.language.enum).toEqual([
      "auto",
      "zh-CN",
      "en",
      "ja",
    ]);
  });

  it("does not write a file when approval is rejected", async () => {
    const { definition } = setupTool({ approved: false });
    const result = await definition.handler.call(definition, {
      source: "source.docx",
    });
    expect(result).toBe("rejected");
    expect(mockCreateFilesLib.saveGeneratedFile).not.toHaveBeenCalled();
  });

  it("creates a preserved copy and registers a download output", async () => {
    const { aibitat, definition } = setupTool();
    const result = JSON.parse(
      await definition.handler.call(definition, { source: "source.docx" })
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        mode: "preserved",
        filename: "formatted-source.docx",
      })
    );
    expect(aibitat.requestToolApproval).toHaveBeenCalledTimes(1);
    expect(aibitat.socket.send).toHaveBeenCalledWith(
      "fileDownloadCard",
      expect.objectContaining({ filename: "formatted-source.docx" })
    );
    expect(mockCreateFilesLib.registerOutput).toHaveBeenCalledWith(
      aibitat,
      "DocxFileDownload",
      expect.any(Object)
    );
  });

  it("rebuilds from parsed content when safe preservation is unsupported", async () => {
    mockFormatterLib.formatDocxBuffer.mockImplementation(() => {
      throw new Error("invalid_docx_styles");
    });
    const { definition } = setupTool();
    const result = JSON.parse(
      await definition.handler.call(definition, { source: "source.docx" })
    );
    expect(result.mode).toBe("reconstructed");
    expect(result.warnings).toContain(
      "source_structure_rebuilt_from_parsed_content"
    );
    expect(mockFormatterLib.rebuildDocxFromContent).toHaveBeenCalled();
  });

  it("rejects unsafe document packages instead of rebuilding them", async () => {
    mockFormatterLib.formatDocxBuffer.mockImplementation(() => {
      throw new Error("active_docx_content_not_supported");
    });
    const { definition } = setupTool();
    const result = JSON.parse(
      await definition.handler.call(definition, { source: "source.docx" })
    );
    expect(result).toEqual({
      success: false,
      error: "active_docx_content_not_supported",
    });
    expect(mockFormatterLib.rebuildDocxFromContent).not.toHaveBeenCalled();
    expect(mockCreateFilesLib.saveGeneratedFile).not.toHaveBeenCalled();
  });
});
