const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

describe("Reader module boundary", () => {
  test("runtime facade depends on server/modules/reader, not endpoint internals", () => {
    const source = read("utils/readerDocumentRuntime/index.js");
    expect(source).toContain('require("../../modules/reader")');
    expect(source).not.toContain("endpoints/workspaceReaderDocuments");
  });

  test("dev-control Reader commands use ReaderRuntime facade", () => {
    const source = read("utils/devControl/readerCommands.js");
    expect(source).toContain('require("../../modules/reader")');
    expect(source).not.toContain("endpoints/workspaceReaderDocuments");
  });

  test("HTTP endpoint is a thin adapter over the Reader module", () => {
    const source = read("endpoints/workspaceReaderDocuments.js");
    expect(source).toContain('require("../modules/reader/httpAdapter")');
    expect(source).not.toContain("function workspaceReaderDocumentsEndpoints");
  });

  test("Reader module separates runtime facade from HTTP adapter", () => {
    const runtime = read("modules/reader/runtime.js");
    const httpAdapter = read("modules/reader/httpAdapter.js");
    const httpRoutes = read("modules/reader/httpRoutes.js");
    expect(runtime).toContain('require("./documents")');
    expect(runtime).toContain('require("./accessGate")');
    expect(runtime).toContain('require("./previewPipeline")');
    expect(runtime).toContain('require("./postprocessPipeline")');
    expect(runtime).toContain('require("./pdfMedia")');
    expect(runtime).toContain('require("./classificationPipeline")');
    expect(runtime).toContain("ReaderRuntime");
    expect(runtime).not.toContain("legacyCore");
    expect(runtime).not.toContain("compatPrivate");
    expect(httpAdapter).toContain("workspaceReaderDocumentsEndpoints");
    expect(httpAdapter).not.toContain("ReaderRuntime");
    expect(httpRoutes).not.toContain('require("./legacyCore")');
    expect(httpRoutes).toContain('require("./httpIngestHandlers")');
    expect(httpRoutes).toContain('require("./httpDocumentHandlers")');
    expect(httpRoutes).toContain('require("./httpPostprocessHandlers")');
  });

  test("Reader implementation is a small composition layer over focused modules", () => {
    const implementation = read("modules/reader/implementation.js");
    expect(implementation).toContain('require("./httpRoutes")');
    expect(implementation).toContain('require("./runtime")');
    expect(implementation).not.toContain("function workspaceReaderDocumentsEndpoints");
    expect(implementation).not.toContain("_private");
  });

  test("Reader focused core modules do not import endpoint or legacy route code", () => {
    const focusedModules = [
      "modules/reader/documentsCore.js",
      "modules/reader/documentCatalog.js",
      "modules/reader/accessGate.js",
      "modules/reader/httpContentHandlers.js",
      "modules/reader/httpDocumentHandlers.js",
      "modules/reader/httpIngestHandlers.js",
      "modules/reader/httpPostprocessHandlers.js",
      "modules/reader/httpUtilityHandlers.js",
      "modules/reader/previewPipeline.js",
      "modules/reader/classificationPipeline.js",
      "modules/reader/classificationCore.js",
      "modules/reader/pdfMedia.js",
      "modules/reader/pdfMediaCore.js",
      "modules/reader/postprocessPipeline.js",
      "modules/reader/postprocessCore.js",
      "modules/reader/thumbnailMaintenance.js",
      "modules/reader/formatReaders.js",
      "modules/reader/ocr.js",
      "modules/reader/originalStream.js",
      "modules/reader/ingestCore.js",
      "modules/reader/readerLinks.js",
    ];

    for (const modulePath of focusedModules) {
      const source = read(modulePath);
      expect(source).not.toContain("workspaceReaderDocuments");
      expect(source).not.toContain('require("./legacyCore")');
    }
  });

  test("Reader module no longer exposes legacy private compatibility files", () => {
    const readerModuleDir = path.join(ROOT, "modules/reader");
    const implementation = read("modules/reader/implementation.js");
    const httpAdapter = read("modules/reader/httpAdapter.js");
    const index = read("modules/reader/index.js");

    expect(fs.existsSync(path.join(readerModuleDir, "legacyCore.js"))).toBe(
      false
    );
    expect(fs.existsSync(path.join(readerModuleDir, "compatPrivate.js"))).toBe(
      false
    );
    expect(implementation).not.toContain("_private");
    expect(httpAdapter).not.toContain("_private");
    expect(index).not.toContain("_private");
  });
});
