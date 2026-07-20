const bodyParser = require("body-parser");
const crypto = require("crypto");

const MIB = 1024 * 1024;
const LIMITS = Object.freeze({
  default: { name: "default", bytes: 3 * MIB, parserLimit: "3mb" },
  rawText: { name: "raw-text", bytes: 32 * MIB, parserLimit: "32mb" },
  webhook: { name: "webhook", bytes: 1 * MIB, parserLimit: "1mb" },
  chatAttachmentPart: {
    name: "chat-attachment-part",
    bytes: 8 * MIB,
    parserLimit: "8mb",
  },
  legacy: { name: "legacy", bytes: 3 * 1024 * MIB, parserLimit: "3gb" },
});

const RAW_TEXT_ROUTES = [
  /^\/api\/v1\/document\/raw-text(?:\/|$)/,
  /^\/api\/reader-documents\/raw-text(?:\/|$)/,
];
const RAW_WEBHOOK_ROUTES = [/^\/api\/wechat\/webhook(?:\/|$)/];
const CHAT_ATTACHMENT_PART_ROUTES = [
  /^\/api\/workspace\/[^/]+\/chat-attachments\/uploads\/[^/]+\/parts\/\d+(?:\/|$)/,
];

function enabled(env = process.env) {
  return (
    String(env.ATHENA_REQUEST_LIMITS_V2 || "true").toLowerCase() !== "false"
  );
}

function requestPath(request) {
  return String(request.originalUrl || request.url || "").split("?")[0];
}

function limitClassForRequest(request, env = process.env) {
  if (!enabled(env)) return LIMITS.legacy;
  const pathname = requestPath(request);
  if (CHAT_ATTACHMENT_PART_ROUTES.some((route) => route.test(pathname)))
    return LIMITS.chatAttachmentPart;
  if (RAW_WEBHOOK_ROUTES.some((route) => route.test(pathname)))
    return LIMITS.webhook;
  if (RAW_TEXT_ROUTES.some((route) => route.test(pathname)))
    return LIMITS.rawText;
  return LIMITS.default;
}

function sha256Base64Url(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("base64url");
}

function verifier({ retainRawBody = false } = {}) {
  return function verifyRequestBody(request, _response, buffer, encoding) {
    request.bodyByteLength = buffer?.length || 0;
    request.rawBodySha256 = sha256Base64Url(buffer || Buffer.alloc(0));
    if (retainRawBody && buffer?.length)
      request.rawBody = buffer.toString(encoding || "utf8");
  };
}

function parserSet(limitClass) {
  const verify = verifier({ retainRawBody: limitClass.name === "webhook" });
  const options = { limit: limitClass.parserLimit, verify };
  return [
    bodyParser.raw({ ...options, type: "application/octet-stream" }),
    bodyParser.text(options),
    bodyParser.json(options),
    bodyParser.urlencoded({ ...options, extended: true }),
  ];
}

const parserCache = new Map();

function parsersFor(limitClass) {
  if (!parserCache.has(limitClass.name))
    parserCache.set(limitClass.name, parserSet(limitClass));
  return parserCache.get(limitClass.name);
}

function runParsers(parsers, request, response, next) {
  let index = 0;
  function run(error = null) {
    if (error) return next(error);
    const parser = parsers[index++];
    if (!parser) return next();
    return parser(request, response, run);
  }
  return run();
}

function requestBodyPolicy(request, response, next) {
  const limitClass = limitClassForRequest(request);
  request.bodyLimitClass = limitClass.name;
  request.bodyLimitBytes = limitClass.bytes;

  const contentLength = Number(request.headers?.["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > limitClass.bytes) {
    const error = new Error("request_entity_too_large");
    error.type = "entity.too.large";
    error.status = 413;
    return next(error);
  }

  return runParsers(parsersFor(limitClass), request, response, next);
}

function requestBodyLimitErrorHandler(error, request, response, next) {
  if (error?.type !== "entity.too.large" && error?.status !== 413)
    return next(error);
  return response.status(413).json({
    success: false,
    error: "request_entity_too_large",
    limitClass: request.bodyLimitClass || "default",
    maxBytes: Number(request.bodyLimitBytes || LIMITS.default.bytes),
  });
}

module.exports = {
  LIMITS,
  limitClassForRequest,
  requestBodyLimitErrorHandler,
  requestBodyPolicy,
  sha256Base64Url,
};
