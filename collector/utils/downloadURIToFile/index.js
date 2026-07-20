const { WATCH_DIRECTORY, ACCEPTED_MIMES } = require("../constants");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { Readable, Transform } = require("stream");
const { validURL } = require("../url");
const { default: slugify } = require("slugify");
const { redactUrl } = require("../security/redaction");
const { safeFetch } = require("../networkGuard");
const { currentTaskDirectory, currentTaskSignal } = require("../taskContext");

const MAX_FILE_BYTES = 500 * 1_024 * 1_024;

// Add a custom slugify extension for slashing to handle URLs with paths.
slugify.extend({ "/": "-" });

/**
 * Maps a MIME type to the preferred file extension using ACCEPTED_MIMES.
 * Returns null if the MIME type is not recognized or if there are no possible extensions.
 * @param {string} mimeType - The MIME type to resolve (e.g., "application/pdf")
 * @returns {string|null} - The file extension (e.g., ".pdf") or null
 */
function mimeToExtension(mimeType) {
  if (!mimeType || !ACCEPTED_MIMES.hasOwnProperty(mimeType)) return null;
  const possibleExtensions = ACCEPTED_MIMES[mimeType] ?? [];
  if (possibleExtensions.length === 0) return null;
  return possibleExtensions[0];
}

/**
 * Download a file to the hotdir
 * @param {string} url - The URL of the file to download
 * @param {number} maxTimeout - The maximum timeout in milliseconds
 * @returns {Promise<{success: boolean, fileLocation: string|null, reason: string|null}>} - The path to the downloaded file
 */
async function downloadURIToFile(url, maxTimeout = 5 * 60_000) {
  if (!url || typeof url !== "string" || !validURL(url))
    return { success: false, reason: "Not a valid URL.", fileLocation: null };

  try {
    const res = await safeFetch(url, {
      signal: currentTaskSignal(),
      timeoutMs: maxTimeout,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const declaredBytes = Number(res.headers.get("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_FILE_BYTES)
      throw new Error("Remote file exceeds the 500 MiB download limit.");

    const urlObj = new URL(url);
    const sluggedPath = slugify(urlObj.pathname, { lower: true });
    let filename = `${urlObj.hostname}-${sluggedPath}`;

    const existingExt = path.extname(filename).toLowerCase();
    const { SUPPORTED_FILETYPE_CONVERTERS } = require("../constants");

    // If the filename does not already have a supported file extension,
    // try to infer one from the response Content-Type header.
    // This handles URLs like https://arxiv.org/pdf/2307.10265 where the
    // path has no explicit extension but the server responds with
    // Content-Type: application/pdf.
    if (!SUPPORTED_FILETYPE_CONVERTERS.hasOwnProperty(existingExt)) {
      const { parseContentType } = require("../../processLink/helpers");
      const contentType = parseContentType(res.headers.get("Content-Type"));
      const inferredExt = mimeToExtension(contentType);
      if (inferredExt) {
        console.log(
          `[Collector] URL path has no recognized extension. Inferred ${inferredExt} from Content-Type: ${contentType}`
        );
        filename += inferredExt;
      }
    }

    const localFilePath = path.join(WATCH_DIRECTORY, filename);
    const taskDirectory = currentTaskDirectory();
    if (!taskDirectory)
      throw new Error("Collector task isolation context is unavailable.");
    const partialPath = path.join(taskDirectory, `${filename}.part`);
    let bytes = 0;
    const byteLimit = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_FILE_BYTES)
          return callback(
            new Error("Remote file exceeds the 500 MiB download limit.")
          );
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body),
      byteLimit,
      fs.createWriteStream(partialPath, { flags: "wx", mode: 0o600 })
    );
    await fs.promises.rename(partialPath, localFilePath);

    console.log(`[SUCCESS]: File ${localFilePath} downloaded to hotdir.`);
    return { success: true, fileLocation: localFilePath, reason: null };
  } catch (error) {
    if (error?.code === "collector_destination_forbidden") throw error;
    console.error(
      `Error writing to hotdir: ${error} for URL: ${redactUrl(url)}`
    );
    return { success: false, reason: error.message, fileLocation: null };
  }
}

module.exports = {
  downloadURIToFile,
  mimeToExtension,
  MAX_FILE_BYTES,
};
