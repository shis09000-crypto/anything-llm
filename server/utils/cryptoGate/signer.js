const crypto = require("crypto");

function sha512Hex(value = "") {
  return crypto.createHash("sha512").update(value).digest("hex");
}

function signRestRequest({
  method,
  requestPath,
  queryString = "",
  body = "",
  timestamp,
  secret,
}) {
  const bodyString =
    body === null || body === undefined
      ? ""
      : typeof body === "string"
        ? body
        : JSON.stringify(body);
  const payloadHash = sha512Hex(bodyString);
  const canonical = [
    String(method || "GET").toUpperCase(),
    requestPath,
    queryString,
    payloadHash,
    String(timestamp),
  ].join("\n");
  return crypto.createHmac("sha512", secret).update(canonical).digest("hex");
}

function signWsRequest({ channel, event, time, secret }) {
  const message = `channel=${channel}&event=${event}&time=${time}`;
  return crypto.createHmac("sha512", secret).update(message).digest("hex");
}

module.exports = {
  signRestRequest,
  signWsRequest,
};
