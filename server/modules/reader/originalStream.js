const fs = require("fs");
const { readerStreamCacheControlForRequest } = require("./accessGate");

function readerOriginalEtag(originalPath, metadata = {}) {
  const fingerprint =
    metadata.originalFingerprint ||
    metadata.fingerprint ||
    metadata.previewFingerprint ||
    null;
  if (fingerprint) return `"reader-${String(fingerprint).replace(/"/g, "")}"`;
  try {
    const stat = fs.statSync(originalPath);
    return `"reader-${stat.size}-${Math.round(stat.mtimeMs)}"`;
  } catch {
    return null;
  }
}

function setReaderOriginalHeaders(
  requestOrResponse,
  responseOrOriginalPath,
  originalPathOrMetadata,
  metadataMaybe = {}
) {
  const legacySignature = typeof responseOrOriginalPath === "string";
  const request = legacySignature ? {} : requestOrResponse;
  const response = legacySignature ? requestOrResponse : responseOrOriginalPath;
  const originalPath = legacySignature
    ? responseOrOriginalPath
    : originalPathOrMetadata;
  const metadata = legacySignature
    ? originalPathOrMetadata || {}
    : metadataMaybe;
  const setHeader = (name, value) => {
    if (typeof response.setHeader === "function")
      return response.setHeader(name, value);
    if (typeof response.header === "function")
      return response.header(name, value);
    response.headers = response.headers || {};
    response.headers[name] = value;
    return undefined;
  };
  const etag = readerOriginalEtag(originalPath, metadata);
  setHeader("Accept-Ranges", "bytes");
  setHeader("Cache-Control", readerStreamCacheControlForRequest(request));
  setHeader("Content-Type", metadata.mimeType || "application/octet-stream");
  if (etag) setHeader("ETag", etag);
  setHeader("X-Reader-Stream", "range");
}

function sendReaderOriginalFile({ request, response, originalPath, metadata }) {
  const startedAt = Date.now();
  const range = request.headers.range || null;
  setReaderOriginalHeaders(request, response, originalPath, metadata);
  response.on("finish", () => {
    console.info("[reader:original]", {
      requestId: request.communicationRequestId || null,
      method: request.method,
      status: response.statusCode,
      range,
      contentRange: response.getHeader("Content-Range") || null,
      contentLength: response.getHeader("Content-Length") || null,
      originalSize: Number(metadata?.size || 0) || null,
      mimeType: metadata?.mimeType || null,
      durationMs: Date.now() - startedAt,
    });
  });
  return response.sendFile(originalPath);
}

module.exports = {
  readerOriginalEtag,
  sendReaderOriginalFile,
  setReaderOriginalHeaders,
};
