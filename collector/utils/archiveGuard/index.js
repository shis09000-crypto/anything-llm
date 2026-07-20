const path = require("path");
const yauzl = require("yauzl");

const ARCHIVE_EXTENSIONS = new Set([
  ".docx",
  ".pptx",
  ".xlsx",
  ".epub",
  ".odt",
  ".odp",
]);
const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_EXPANDED_BYTES = 1_024 * 1_024 * 1_024;

function archiveLimits() {
  return {
    maxFiles:
      Number(process.env.COLLECTOR_ARCHIVE_MAX_FILES) || DEFAULT_MAX_FILES,
    maxExpandedBytes:
      Number(process.env.COLLECTOR_ARCHIVE_MAX_EXPANDED_BYTES) ||
      DEFAULT_MAX_EXPANDED_BYTES,
  };
}

function unsafeEntryName(name = "") {
  const normalized = String(name).replaceAll("\\", "/");
  return (
    normalized.startsWith("/") ||
    /^[a-z]:\//i.test(normalized) ||
    normalized.split("/").includes("..")
  );
}

async function validateArchive(filePath) {
  if (!ARCHIVE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return;
  const limits = archiveLimits();
  await new Promise((resolve, reject) => {
    yauzl.open(
      filePath,
      { lazyEntries: true, autoClose: true },
      (error, zip) => {
        if (error) return reject(error);
        let count = 0;
        let expandedBytes = 0;
        zip.on("error", reject);
        zip.on("end", resolve);
        zip.on("entry", (entry) => {
          count += 1;
          expandedBytes += Number(entry.uncompressedSize) || 0;
          if (unsafeEntryName(entry.fileName)) {
            zip.close();
            return reject(new Error("Archive contains an unsafe output path."));
          }
          if (count > limits.maxFiles) {
            zip.close();
            return reject(new Error("Archive contains too many files."));
          }
          if (expandedBytes > limits.maxExpandedBytes) {
            zip.close();
            return reject(
              new Error("Archive expanded size exceeds the limit.")
            );
          }
          zip.readEntry();
        });
        zip.readEntry();
      }
    );
  });
}

module.exports = {
  ARCHIVE_EXTENSIONS,
  validateArchive,
  _private: { archiveLimits, unsafeEntryName },
};
