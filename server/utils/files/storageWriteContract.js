const fs = require("fs");
const path = require("path");
const { storagePath } = require("../environment");

const REQUIRED_WRITE_DOMAINS = [
  "documents",
  "direct-uploads",
  "embedding-batches",
  "vector-cache",
  "lancedb",
];

function assertWritableDirectory(target, code) {
  try {
    fs.mkdirSync(target, { recursive: true });
    fs.accessSync(target, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch (error) {
    const contractError = new Error(code);
    contractError.code = code;
    contractError.cause = error;
    throw contractError;
  }
}

function assertDocumentPipelineStorage({ includeUploadHotdir = false } = {}) {
  for (const domain of REQUIRED_WRITE_DOMAINS) {
    assertWritableDirectory(
      storagePath(domain),
      `document_pipeline_storage_${domain.replace(/-/g, "_")}_unavailable`
    );
  }

  if (includeUploadHotdir) {
    assertWritableDirectory(
      path.resolve(__dirname, "../../../collector/hotdir"),
      "document_pipeline_upload_hotdir_unavailable"
    );
  }
  return true;
}

module.exports = {
  REQUIRED_WRITE_DOMAINS,
  assertDocumentPipelineStorage,
  assertWritableDirectory,
};
