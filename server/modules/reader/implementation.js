const {
  MAX_READER_FILE_SIZE,
  workspaceReaderDocumentsEndpoints,
} = require("./httpRoutes");
const { ReaderRuntime } = require("./runtime");

module.exports = {
  MAX_READER_FILE_SIZE,
  ReaderRuntime,
  workspaceReaderDocumentsEndpoints,
};
