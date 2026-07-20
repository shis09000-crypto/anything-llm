const bodyParser = require("body-parser");

const LIMITS = Object.freeze({
  control: { maxBytes: 1 * 1_024 * 1_024, parserLimit: "1mb" },
  rawText: { maxBytes: 32 * 1_024 * 1_024, parserLimit: "32mb" },
});

function limitFor(request) {
  return request.path === "/process-raw-text"
    ? { ...LIMITS.rawText, limitClass: "collector_raw_text" }
    : { ...LIMITS.control, limitClass: "collector_control" };
}

function requestBodyPolicy(request, response, next) {
  const limit = limitFor(request);
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit.maxBytes) {
    return sendTooLarge(response, limit);
  }
  const options = {
    limit: limit.parserLimit,
    verify(req, _res, buffer) {
      req.bodyByteLength = buffer.length;
    },
  };
  const contentType = String(request.headers["content-type"] || "");
  const parser = contentType.includes("application/x-www-form-urlencoded")
    ? bodyParser.urlencoded({ ...options, extended: true })
    : contentType.includes("text/")
    ? bodyParser.text(options)
    : bodyParser.json(options);
  return parser(request, response, (error) => {
    if (error?.type === "entity.too.large" || error?.status === 413)
      return sendTooLarge(response, limit);
    if (error) return next(error);
    next();
  });
}

function sendTooLarge(response, limit) {
  return response.status(413).json({
    success: false,
    error: "request_entity_too_large",
    limitClass: limit.limitClass,
    maxBytes: limit.maxBytes,
  });
}

module.exports = { LIMITS, limitFor, requestBodyPolicy };
