const readerDocuments = require("../../endpoints/workspaceReaderDocuments");

// P0 modularization adapter:
// keep endpoint-private Reader runtime helpers behind one import boundary so
// storage providers and future workers do not depend on API endpoint modules
// directly. The implementation can later be replaced by worker/RPC contracts.
const runtime = readerDocuments._private;

module.exports = {
  assertReaderDocumentId: runtime.assertReaderDocumentId,
  metadataWithOriginalUrl: runtime.metadataWithOriginalUrl,
  readReaderMetadata: runtime.readReaderMetadata,
  readerDocumentIsDeleted: runtime.readerDocumentIsDeleted,
  readerDocumentRoot: runtime.readerDocumentRoot,
  readerPostprocessResponse: runtime.readerPostprocessResponse,
};
