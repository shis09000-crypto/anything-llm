const { ReaderRuntime } = require("../../modules/reader");

// Reader runtime compatibility facade. Keep the flat API for current worker,
// provider, and dev-control callers while the implementation lives behind the
// server/modules/reader boundary.
const runtime = {
  ...ReaderRuntime.documents,
  ...ReaderRuntime.access,
  ...ReaderRuntime.preview,
  ...ReaderRuntime.postprocess,
  ...ReaderRuntime.media,
  ...ReaderRuntime.classification,
  ...ReaderRuntime.ocr,
  ...ReaderRuntime.epub,
};

module.exports = {
  assertReaderDocumentId: runtime.assertReaderDocumentId,
  metadataWithOriginalUrl: runtime.metadataWithOriginalUrl,
  readReaderMetadata: runtime.readReaderMetadata,
  readerDocumentIsDeleted: runtime.readerDocumentIsDeleted,
  readerDocumentRoot: runtime.readerDocumentRoot,
  readerPostprocessResponse: runtime.readerPostprocessResponse,
  readerPreviewEngineStatus: runtime.readerPreviewEngineStatus,
  runReaderPostprocessJob: runtime.runReaderPostprocessJob,
  STANDALONE_READER_SCOPE: runtime.STANDALONE_READER_SCOPE,
};
