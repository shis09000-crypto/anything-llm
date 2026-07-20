const express = require("express");
const http = require("http");
const {
  LIMITS,
  limitClassForRequest,
  requestBodyLimitErrorHandler,
  requestBodyPolicy,
  sha256Base64Url,
} = require("../../middleware/requestBodyPolicy");

function request(server, { path = "/api/test", body = "{}" } = {}) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
          })
        );
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("request body policy", () => {
  it("classifies default, raw text, and webhook limits", () => {
    expect(limitClassForRequest({ originalUrl: "/api/workspace/a" })).toBe(
      LIMITS.default
    );
    expect(
      limitClassForRequest({ originalUrl: "/api/v1/document/raw-text" })
    ).toBe(LIMITS.rawText);
    expect(
      limitClassForRequest({ originalUrl: "/api/wechat/webhook?source=test" })
    ).toBe(LIMITS.webhook);
  });

  it("computes the same base64url SHA-256 used by request signing", () => {
    expect(sha256Base64Url(Buffer.from('{"ok":true}'))).toBe(
      "QGLtr3UPuAdOfoPgyQKMlOMkaKi28WFHdDKO8EUVD5M"
    );
  });

  it("rejects oversized default JSON before the route handler", async () => {
    const app = express();
    let handled = false;
    app.use(requestBodyPolicy);
    app.use(requestBodyLimitErrorHandler);
    app.post("/api/test", (req, res) => {
      handled = true;
      res.json({ byteLength: req.bodyByteLength });
    });
    const server = app.listen(0);
    try {
      const result = await request(server, {
        body: JSON.stringify({ value: "x".repeat(LIMITS.default.bytes) }),
      });
      expect(result.status).toBe(413);
      expect(result.body).toEqual(
        expect.objectContaining({
          error: "request_entity_too_large",
          limitClass: "default",
          maxBytes: LIMITS.default.bytes,
        })
      );
      expect(handled).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
