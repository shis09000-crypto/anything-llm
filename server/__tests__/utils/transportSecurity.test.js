const {
  assertProductionTransportConfig,
  corsOptionsForEnvironment,
  ensureSecureWebSocketRequest,
  isSecureRequest,
  setSseTransportHeaders,
  sseTransportHeaders,
  transportSecurityStatus,
  transportSecurityMiddleware,
} = require("../../utils/security/transportSecurity");
const { secureCookieOptions } = require("../../utils/security/cookies");

function responseDouble() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    redirectCode: null,
    redirectUrl: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    redirect(code, url) {
      this.redirectCode = code;
      this.redirectUrl = url;
      return this;
    },
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = { ...this.headers, ...headers };
      return this;
    },
  };
}

describe("production transport security helpers", () => {
  it("requires direct HTTPS or trusted proxy HTTPS in production", () => {
    expect(() =>
      assertProductionTransportConfig({ NODE_ENV: "production" })
    ).toThrow(/Production transport requires/);

    expect(
      assertProductionTransportConfig({
        NODE_ENV: "production",
        ENABLE_HTTPS: "true",
      })
    ).toEqual({ required: true, mode: "direct_https" });

    expect(
      assertProductionTransportConfig({
        NODE_ENV: "production",
        TRUST_PROXY: "true",
        FORCE_HTTPS: "true",
        PUBLIC_APP_URL: "https://athena.example.com",
      })
    ).toEqual({ required: true, mode: "trusted_proxy" });
  });

  it("only trusts X-Forwarded-Proto when TRUST_PROXY is enabled", () => {
    expect(
      isSecureRequest({
        headers: { "x-forwarded-proto": "https,http" },
      })
    ).toBe(false);
    expect(
      isSecureRequest(
        {
          headers: { "x-forwarded-proto": "https,http" },
        },
        { TRUST_PROXY: "true" }
      )
    ).toBe(true);
    expect(isSecureRequest({ socket: { encrypted: true }, headers: {} })).toBe(
      true
    );
    expect(
      isSecureRequest({
        headers: { "x-forwarded-proto": "http" },
      })
    ).toBe(false);
  });

  it("sets HSTS for secure production requests and rejects insecure API calls", () => {
    const secureResponse = responseDouble();
    const next = jest.fn();
    const middleware = transportSecurityMiddleware({
      NODE_ENV: "production",
      FORCE_HTTPS: "true",
      TRUST_PROXY: "true",
    });

    middleware(
      { headers: { "x-forwarded-proto": "https" }, path: "/api/ping" },
      secureResponse,
      next
    );
    expect(next).toHaveBeenCalled();
    expect(secureResponse.headers["Strict-Transport-Security"]).toMatch(
      /max-age/
    );

    const insecureResponse = responseDouble();
    middleware(
      { headers: { "x-forwarded-proto": "http" }, path: "/api/ping" },
      insecureResponse,
      jest.fn()
    );
    expect(insecureResponse.statusCode).toBe(426);
    expect(insecureResponse.body).toEqual({
      success: false,
      error: "https_required",
    });
    expect(
      insecureResponse.headers["Strict-Transport-Security"]
    ).toBeUndefined();
  });

  it("redirects insecure production page requests to PUBLIC_APP_URL", () => {
    const response = responseDouble();
    transportSecurityMiddleware({
      NODE_ENV: "production",
      FORCE_HTTPS: "true",
      PUBLIC_APP_URL: "https://athena.example.com",
    })(
      {
        headers: { "x-forwarded-proto": "http" },
        method: "GET",
        path: "/workspace/demo",
        originalUrl: "/workspace/demo",
      },
      response,
      jest.fn()
    );

    expect(response.redirectCode).toBe(301);
    expect(response.redirectUrl).toBe(
      "https://athena.example.com/workspace/demo"
    );
  });

  it("limits production CORS to configured origins", (done) => {
    const options = corsOptionsForEnvironment({
      NODE_ENV: "production",
      PUBLIC_APP_URL: "https://athena.example.com",
      ATHENA_ALLOWED_ORIGINS: "https://admin.example.com",
    });

    options.origin("https://athena.example.com", (error, allowed) => {
      expect(error).toBeNull();
      expect(allowed).toBe(true);
      options.origin("https://evil.example.com", (blockedError) => {
        expect(blockedError).toBeInstanceOf(Error);
        done();
      });
    });
  });

  it("closes insecure production WebSocket handshakes", () => {
    const socket = { close: jest.fn() };
    expect(
      ensureSecureWebSocketRequest(
        { headers: { "x-forwarded-proto": "http" } },
        socket,
        { NODE_ENV: "production" }
      )
    ).toBe(false);
    expect(socket.close).toHaveBeenCalledWith(
      1008,
      "secure_transport_required"
    );

    const forgedProxySocket = { close: jest.fn() };
    expect(
      ensureSecureWebSocketRequest(
        {
          headers: {
            "x-forwarded-proto": "https",
            origin: "https://athena.example.com",
          },
        },
        forgedProxySocket,
        { NODE_ENV: "production" }
      )
    ).toBe(false);

    const trustedProxySocket = { close: jest.fn() };
    expect(
      ensureSecureWebSocketRequest(
        {
          headers: {
            "x-forwarded-proto": "https",
            origin: "https://athena.example.com",
          },
        },
        trustedProxySocket,
        { NODE_ENV: "production", TRUST_PROXY: "true" }
      )
    ).toBe(true);

    const insecureOriginSocket = { close: jest.fn() };
    expect(
      ensureSecureWebSocketRequest(
        {
          headers: {
            "x-forwarded-proto": "https",
            origin: "http://athena.example.com",
          },
        },
        insecureOriginSocket,
        { NODE_ENV: "production", TRUST_PROXY: "true" }
      )
    ).toBe(false);
    expect(insecureOriginSocket.close).toHaveBeenCalledWith(
      1008,
      "secure_transport_required"
    );
  });

  it("centralizes SSE proxy-safe transport headers", () => {
    expect(sseTransportHeaders()).toMatchObject({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const response = responseDouble();
    setSseTransportHeaders(response, {
      "Access-Control-Allow-Origin": "*",
    });
    expect(response.headers).toMatchObject({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });
  });

  it("returns a redacted transport security status summary", () => {
    const status = transportSecurityStatus({
      NODE_ENV: "production",
      TRUST_PROXY: "true",
      FORCE_HTTPS: "true",
      PUBLIC_APP_URL: "https://athena.example.com",
      HTTPS_KEY_PATH: "/secret/key.pem",
    });

    expect(status).toMatchObject({
      mode: "trusted_proxy",
      production: true,
      httpsRequired: true,
      trustProxyEnabled: true,
      forceHttps: true,
      publicAppUrlHttps: true,
      hstsConfigured: true,
      tlsMinVersion: "TLSv1.2",
      tls13Recommended: true,
      webSocketSecureRequired: true,
    });
    expect(JSON.stringify(status)).not.toContain("key.pem");
    expect(status.sseHeaders["X-Accel-Buffering"]).toBe("no");
  });

  it("centralizes production-safe cookie defaults", () => {
    expect(secureCookieOptions({}, { NODE_ENV: "production" })).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
    });
    expect(
      secureCookieOptions({ sameSite: "none" }, { NODE_ENV: "development" })
    ).toEqual({
      httpOnly: true,
      sameSite: "none",
      secure: true,
    });
  });
});

describe("SSL boot transport fallback", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  function mockBootDependencies() {
    jest.doMock("../../models/telemetry", () => ({
      Telemetry: { flush: jest.fn() },
    }));
    jest.doMock("../../utils/BackgroundWorkers", () => ({
      BackgroundService: jest.fn(),
    }));
    jest.doMock("../../utils/EncryptionManager", () => ({
      EncryptionManager: jest.fn(),
    }));
    jest.doMock("../../utils/comKey", () => ({
      CommunicationKey: jest.fn(),
    }));
    jest.doMock("../../utils/telemetry", () => jest.fn());
    jest.doMock("../../utils/boot/eagerLoadContextWindows", () => jest.fn());
    jest.doMock("../../utils/boot/markOnboarded", () => jest.fn());
    jest.doMock("../../utils/PushNotifications", () => ({
      PushNotifications: { setupPushNotificationService: jest.fn() },
    }));
    jest.doMock("../../utils/telegramBot", () => ({
      TelegramBotService: { bootIfActive: jest.fn() },
    }));
    jest.doMock("../../utils/openclawWeixin", () => ({
      cleanupOpenClawWeixinLoginChild: jest.fn(),
    }));
  }

  it("passes TLS1.2+ and strong cipher options to HTTPS server", () => {
    mockBootDependencies();
    const server = {
      listen: jest.fn(function () {
        return server;
      }),
      on: jest.fn(function () {
        return server;
      }),
    };
    const createServer = jest.fn(() => server);
    jest.doMock("https", () => ({ createServer }));
    jest.doMock("fs", () => {
      const actualFs = jest.requireActual("fs");
      return {
        ...actualFs,
        readFileSync: jest.fn((filePath, ...args) => {
          if (filePath === "/certs/key.pem") return Buffer.from("KEY");
          if (filePath === "/certs/cert.pem") return Buffer.from("CERT");
          return actualFs.readFileSync(filePath, ...args);
        }),
      };
    });
    jest.doMock("@mintplex-labs/express-ws", () => ({
      default: jest.fn(),
    }));
    jest.spyOn(console, "log").mockImplementation(() => {});

    process.env.NODE_ENV = "production";
    process.env.ENABLE_HTTPS = "true";
    process.env.HTTPS_KEY_PATH = "/certs/key.pem";
    process.env.HTTPS_CERT_PATH = "/certs/cert.pem";

    const { bootSSL } = require("../../utils/boot");
    bootSSL({}, 3001);

    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        minVersion: "TLSv1.2",
        honorCipherOrder: true,
        ciphers: expect.stringContaining("ECDHE-RSA-AES256-GCM-SHA384"),
      }),
      expect.any(Object)
    );
  });

  it("does not fall back to HTTP when production SSL boot fails", () => {
    mockBootDependencies();
    jest.doMock("fs", () => {
      const actualFs = jest.requireActual("fs");
      return {
        ...actualFs,
        readFileSync: jest.fn((filePath, ...args) => {
          if (["/missing/key.pem", "/missing/cert.pem"].includes(filePath))
            throw new Error("missing cert");
          return actualFs.readFileSync(filePath, ...args);
        }),
      };
    });
    jest.spyOn(console, "error").mockImplementation(() => {});

    process.env.NODE_ENV = "production";
    process.env.ENABLE_HTTPS = "true";
    process.env.HTTPS_KEY_PATH = "/missing/key.pem";
    process.env.HTTPS_CERT_PATH = "/missing/cert.pem";

    const { bootSSL } = require("../../utils/boot");
    expect(() => bootSSL({})).toThrow();
  });
});
