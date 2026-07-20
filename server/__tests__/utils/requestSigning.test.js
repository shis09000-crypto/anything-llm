const crypto = require("crypto");
process.env.ENCRYPTION_MASTER_KEY =
  process.env.ENCRYPTION_MASTER_KEY ||
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const mockFindFirst = jest.fn();
const mockFindMany = jest.fn();
const mockNonceCreate = jest.fn();
const mockNonceDeleteMany = jest.fn();
const mockUpsert = jest.fn();
const mockUpdateMany = jest.fn();
const mockLogEvent = jest.fn();
const routeCases = require("../../scripts/request-signing-route-cases.json");

jest.mock("../../utils/prisma", () => ({
  athena_clients: {
    findFirst: (...args) => mockFindFirst(...args),
    findMany: (...args) => mockFindMany(...args),
    upsert: (...args) => mockUpsert(...args),
    updateMany: (...args) => mockUpdateMany(...args),
  },
  athena_request_nonces: {
    create: (...args) => mockNonceCreate(...args),
    deleteMany: (...args) => mockNonceDeleteMany(...args),
  },
}));

jest.mock("../../utils/EncryptionManager", () => ({
  EncryptionManager: class {
    encrypt(value) {
      return `enc:${value}`;
    }
    decrypt(value) {
      return String(value || "").replace(/^enc:/, "");
    }
  },
}));

jest.mock("../../models/eventLogs", () => ({
  EventLogs: {
    logEvent: (...args) => mockLogEvent(...args),
  },
}));

const {
  CLIENT_REVOKED_ERROR,
  DEVICE_SIGNATURE_PREFIX,
  DEVICE_SIGNATURE_VERSION,
  INVALID_SIGNATURE_ERROR,
  SIGNATURE_VERSION,
  canonicalSigningString,
  ensureClientSigningSecret,
  hmacBase64Url,
  requireSignedHighRiskRequest,
  isHighRiskSignedRequest,
  rotateAllSigningSecrets,
  rotateSigningSecret,
  sha256Base64Url,
  verifySignedRequest,
  verifySignedWebSocketMessage,
} = require("../../utils/requestSigning");

function requestDouble({
  method = "POST",
  path = "/api/workspace/demo/tool-approval",
  body = JSON.stringify({ requestId: "approval-1", approved: true }),
  clientId = "client_abc",
  userId = 10,
  headers = {},
} = {}) {
  const lowerHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    method,
    originalUrl: path,
    url: path,
    rawBody: body,
    headers: lowerHeaders,
    clientContext: {
      clientId,
      userId,
      platform: "web",
      trustLevel: "low",
      appVersion: "test",
      requestId: headers["X-Athena-Request-Id"] || "req_1",
      legacy: false,
    },
    header(name) {
      return lowerHeaders[String(name).toLowerCase()] || null;
    },
  };
}

function signedHeaders({
  method = "POST",
  path = "/api/workspace/demo/tool-approval",
  body = JSON.stringify({ requestId: "approval-1", approved: true }),
  clientId = "client_abc",
  requestId = "req_1",
  nonce = "nonce_1",
  timestamp = String(Date.now()),
  secret = "secret_abc",
} = {}) {
  const bodySha256 = sha256Base64Url(body);
  const signature = hmacBase64Url(
    secret,
    canonicalSigningString({
      method,
      canonicalPath: path,
      timestamp,
      nonce,
      requestId,
      clientId,
      bodySha256,
    })
  );

  return {
    "X-Athena-Client-Id": clientId,
    "X-Athena-Request-Id": requestId,
    "X-Athena-Timestamp": timestamp,
    "X-Athena-Nonce": nonce,
    "X-Athena-Body-SHA256": bodySha256,
    "X-Athena-Signature": signature,
    "X-Athena-Signature-Version": SIGNATURE_VERSION,
  };
}

function deviceSignedHeaders({
  method = "POST",
  path = "/api/workspace/demo/tool-approval",
  body = JSON.stringify({ requestId: "approval-1", approved: true }),
  clientId = "client_abc",
  requestId = "req_1",
  nonce = "nonce_device_1",
  timestamp = String(Date.now()),
} = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const publicJwk = publicKey.export({ format: "jwk" });
  const devicePublicKey = JSON.stringify({
    kty: "EC",
    crv: "P-256",
    x: publicJwk.x,
    y: publicJwk.y,
    ext: true,
    key_ops: ["verify"],
  });
  const bodySha256 = sha256Base64Url(body);
  const signature = crypto
    .sign(
      "sha256",
      Buffer.from(
        canonicalSigningString({
          method,
          canonicalPath: path,
          timestamp,
          nonce,
          requestId,
          clientId,
          bodySha256,
          prefix: DEVICE_SIGNATURE_PREFIX,
        })
      ),
      { key: privateKey, dsaEncoding: "ieee-p1363" }
    )
    .toString("base64url");

  return {
    "X-Athena-Client-Id": clientId,
    "X-Athena-Request-Id": requestId,
    "X-Athena-Timestamp": timestamp,
    "X-Athena-Nonce": nonce,
    "X-Athena-Body-SHA256": bodySha256,
    "X-Athena-Signature": signature,
    "X-Athena-Signature-Version": DEVICE_SIGNATURE_VERSION,
    "X-Athena-Device-Public-Key": devicePublicKey,
    "X-Athena-Device-Key-Algorithm": "p256-v1",
  };
}

describe("request signing", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalWarnOnly = process.env.ATHENA_SIGNING_WARN_ONLY;
  const originalRequireSigned = process.env.ATHENA_REQUIRE_SIGNED_HIGH_RISK;
  const originalDeviceRequired = process.env.REQUEST_SIGNING_DEVICE_REQUIRED;
  const originalHmacCompat = process.env.REQUEST_SIGNING_HMAC_COMPAT;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindFirst.mockResolvedValue({
      id: 1,
      clientId: "client_abc",
      userId: 10,
      signingSecretEncrypted: "enc:secret_abc",
      signingSecretVersion: SIGNATURE_VERSION,
      signingSecretRotatedAt: null,
      revokedAt: null,
    });
    mockFindMany.mockResolvedValue([]);
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockNonceCreate.mockResolvedValue({ id: 1 });
    mockNonceDeleteMany.mockResolvedValue({ count: 0 });
    mockLogEvent.mockResolvedValue({ eventLog: { id: 1 }, message: null });
    process.env.NODE_ENV = "test";
    delete process.env.ATHENA_SIGNING_WARN_ONLY;
    delete process.env.ATHENA_REQUIRE_SIGNED_HIGH_RISK;
    delete process.env.REQUEST_SIGNING_DEVICE_REQUIRED;
    delete process.env.REQUEST_SIGNING_HMAC_COMPAT;
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalWarnOnly === undefined)
      delete process.env.ATHENA_SIGNING_WARN_ONLY;
    else process.env.ATHENA_SIGNING_WARN_ONLY = originalWarnOnly;
    if (originalRequireSigned === undefined)
      delete process.env.ATHENA_REQUIRE_SIGNED_HIGH_RISK;
    else process.env.ATHENA_REQUIRE_SIGNED_HIGH_RISK = originalRequireSigned;
    if (originalDeviceRequired === undefined)
      delete process.env.REQUEST_SIGNING_DEVICE_REQUIRED;
    else process.env.REQUEST_SIGNING_DEVICE_REQUIRED = originalDeviceRequired;
    if (originalHmacCompat === undefined)
      delete process.env.REQUEST_SIGNING_HMAC_COMPAT;
    else process.env.REQUEST_SIGNING_HMAC_COMPAT = originalHmacCompat;
  });

  it("accepts a valid signed high-risk request and claims nonce", async () => {
    const body = JSON.stringify({ requestId: "approval-1", approved: true });
    const request = requestDouble({
      body,
      headers: signedHeaders({ body }),
    });

    await expect(verifySignedRequest(request)).resolves.toMatchObject({
      ok: true,
      requestId: "req_1",
      signatureVersion: SIGNATURE_VERSION,
    });
    expect(mockNonceCreate).toHaveBeenCalledTimes(1);
  });

  it("accepts a device public-key signed request and binds the public key once", async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 1,
      clientId: "client_abc",
      userId: 10,
      publicKey: null,
      revokedAt: null,
    });
    const body = JSON.stringify({ requestId: "approval-1", approved: true });
    const request = requestDouble({
      body,
      headers: deviceSignedHeaders({ body }),
    });

    await expect(verifySignedRequest(request)).resolves.toMatchObject({
      ok: true,
      requestId: "req_1",
      signatureVersion: DEVICE_SIGNATURE_VERSION,
    });
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deviceFingerprintVersion: "p256-v1",
          publicKey: expect.stringContaining('"P-256"'),
          trustLevel: "medium",
        }),
      })
    );
    expect(mockNonceCreate).toHaveBeenCalledTimes(1);
  });

  it("accepts a pending device key only on the rotation commit route", async () => {
    const body = JSON.stringify({ publicKey: "pending" });
    const path = "/api/client-identity/device-key-rotation/commit";
    const headers = deviceSignedHeaders({ body, path });
    mockFindFirst.mockResolvedValue({
      id: 1,
      clientId: "client_abc",
      userId: 10,
      publicKey: JSON.stringify({
        kty: "EC",
        crv: "P-256",
        x: "old",
        y: "old",
      }),
      pendingPublicKey: headers["X-Athena-Device-Public-Key"],
      pendingDeviceKeyAlgorithm: "p256-v1",
      pendingDeviceKeyExpiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    });
    await expect(
      verifySignedRequest(requestDouble({ body, path, headers }))
    ).resolves.toMatchObject({ ok: true });

    const otherPath = "/api/workspace/demo/tool-approval";
    const otherHeaders = deviceSignedHeaders({
      body,
      path: otherPath,
      nonce: "pending-other-route",
    });
    mockFindFirst.mockResolvedValue({
      id: 1,
      clientId: "client_abc",
      userId: 10,
      publicKey: JSON.stringify({
        kty: "EC",
        crv: "P-256",
        x: "old",
        y: "old",
      }),
      pendingPublicKey: otherHeaders["X-Athena-Device-Public-Key"],
      pendingDeviceKeyAlgorithm: "p256-v1",
      pendingDeviceKeyExpiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    });
    await expect(
      verifySignedRequest(
        requestDouble({ body, path: otherPath, headers: otherHeaders })
      )
    ).resolves.toMatchObject({ ok: false, reasonCode: "device_key_mismatch" });
  });

  it("rejects body tampering, expired timestamps, replay, mismatch, and missing signature", async () => {
    const headers = signedHeaders({ body: JSON.stringify({ ok: true }) });
    await expect(
      verifySignedRequest(
        requestDouble({ body: JSON.stringify({ ok: false }), headers })
      )
    ).resolves.toMatchObject({ ok: false, reasonCode: "body_hash_mismatch" });

    await expect(
      verifySignedRequest(
        requestDouble({
          headers: signedHeaders({
            timestamp: String(Date.now() - 60 * 60 * 1000),
          }),
        })
      )
    ).resolves.toMatchObject({ ok: false, reasonCode: "expired_timestamp" });

    mockNonceCreate.mockRejectedValueOnce({ code: "P2002" });
    await expect(
      verifySignedRequest(
        requestDouble({ headers: signedHeaders({ nonce: "replayed" }) })
      )
    ).resolves.toMatchObject({ ok: false, reasonCode: "nonce_replay" });

    await expect(
      verifySignedRequest(
        requestDouble({
          clientId: "client_other",
          headers: signedHeaders({ clientId: "client_abc" }),
        })
      )
    ).resolves.toMatchObject({ ok: false, reasonCode: "client_mismatch" });

    await expect(
      verifySignedRequest(requestDouble({ headers: {} }))
    ).resolves.toMatchObject({
      ok: false,
      reasonCode: "missing_signature",
    });
  });

  it("warn-only mode does not block but production enforcement does", async () => {
    const request = requestDouble({ headers: {} });
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      process.env.NODE_ENV = "development";
      await requireSignedHighRiskRequest(request, response, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(response.status).not.toHaveBeenCalled();

      process.env.NODE_ENV = "production";
      next.mockClear();
      await requireSignedHighRiskRequest(request, response, next);
      expect(next).not.toHaveBeenCalled();
      expect(response.status).toHaveBeenCalledWith(401);
      expect(response.json).toHaveBeenCalledWith({
        success: false,
        error: "invalid_signed_request",
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("matches the configured high-risk route set without signing normal routes", () => {
    for (const [method, path] of routeCases.signed) {
      expect(isHighRiskSignedRequest({ method, path })).toBe(true);
    }

    for (const [method, path] of routeCases.unsigned) {
      expect(isHighRiskSignedRequest({ method, path })).toBe(false);
    }
  });

  it("enforces signing on newly covered account safety routes in production", async () => {
    process.env.NODE_ENV = "production";
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    await requireSignedHighRiskRequest(
      requestDouble({
        method: "DELETE",
        path: "/api/auth/passkeys/12",
        body: "",
        headers: {},
      }),
      response,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: "invalid_signed_request",
    });
  });

  it("requires device signatures for high-risk production requests unless HMAC compatibility is enabled", async () => {
    process.env.NODE_ENV = "production";
    const hmacRequest = requestDouble({ headers: signedHeaders() });
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    await requireSignedHighRiskRequest(hmacRequest, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: INVALID_SIGNATURE_ERROR,
    });

    process.env.REQUEST_SIGNING_HMAC_COMPAT = "true";
    response.status.mockClear();
    response.json.mockClear();
    next.mockClear();
    await requireSignedHighRiskRequest(
      requestDouble({
        headers: signedHeaders({ nonce: "compat_nonce" }),
      }),
      response,
      next
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(response.status).not.toHaveBeenCalled();
  });

  it("rejects revoked clients with CLIENT_REVOKED in enforced mode", async () => {
    mockFindFirst.mockResolvedValue({
      id: 1,
      clientId: "client_abc",
      userId: 10,
      signingSecretEncrypted: "enc:secret_abc",
      signingSecretVersion: SIGNATURE_VERSION,
      signingSecretRotatedAt: null,
      revokedAt: new Date(),
    });
    const request = requestDouble({ headers: signedHeaders() });

    await expect(verifySignedRequest(request)).resolves.toMatchObject({
      ok: false,
      reasonCode: "client_revoked",
    });

    process.env.NODE_ENV = "production";
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();
    await requireSignedHighRiskRequest(request, response, next);
    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: CLIENT_REVOKED_ERROR,
    });
  });

  it("does not issue signing secrets to revoked clients", async () => {
    mockFindFirst.mockResolvedValue({
      id: 1,
      clientId: "client_abc",
      userId: 10,
      signingSecretEncrypted: "enc:secret_abc",
      signingSecretVersion: SIGNATURE_VERSION,
      signingSecretRotatedAt: null,
      revokedAt: new Date(),
    });

    await expect(
      ensureClientSigningSecret({
        context: {
          userId: 10,
          clientId: "client_abc",
          platform: "web",
          trustLevel: "low",
          capabilities: {},
          capabilitySource: "unknown",
        },
      })
    ).resolves.toMatchObject({ revoked: true });
  });

  it("rotates current client secret and returns only current client secret", async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 1,
      clientId: "client_abc",
      userId: 10,
      signingSecretEncrypted: "enc:old_secret",
      signingSecretVersion: "sec_old",
      revokedAt: null,
    });

    const result = await rotateSigningSecret({
      userId: 10,
      clientId: "client_abc",
      actorClientId: "client_abc",
    });

    expect(result).toMatchObject({
      rotated: true,
      oldVersion: "sec_old",
    });
    expect(result.newVersion).toMatch(/^sec_/);
    expect(result.secret).toBeTruthy();
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 10,
          clientId: "client_abc",
          revokedAt: null,
        }),
        data: expect.objectContaining({
          signingSecretEncrypted: expect.stringMatching(/^enc:/),
          signingSecretVersion: expect.stringMatching(/^sec_/),
          signingSecretIssuedAt: expect.any(Date),
          signingSecretRotatedAt: expect.any(Date),
        }),
      })
    );

    mockFindFirst.mockResolvedValueOnce({
      id: 2,
      clientId: "client_other",
      userId: 10,
      signingSecretEncrypted: "enc:old_other",
      signingSecretVersion: "sec_other_old",
      revokedAt: null,
    });
    const other = await rotateSigningSecret({
      userId: 10,
      clientId: "client_other",
      actorClientId: "client_abc",
    });
    expect(other.secret).toBeNull();
  });

  it("does not rotate revoked clients", async () => {
    const revokedAt = new Date();
    mockFindFirst.mockResolvedValueOnce({
      id: 1,
      clientId: "client_abc",
      userId: 10,
      signingSecretEncrypted: "enc:old_secret",
      signingSecretVersion: "sec_old",
      revokedAt,
    });

    await expect(
      rotateSigningSecret({
        userId: 10,
        clientId: "client_abc",
        actorClientId: "client_abc",
      })
    ).resolves.toMatchObject({ revoked: true });
  });

  it("old rotated secret fails and current rotated secret passes", async () => {
    mockFindFirst.mockResolvedValue({
      id: 1,
      clientId: "client_abc",
      userId: 10,
      signingSecretEncrypted: "enc:new_secret",
      signingSecretVersion: "sec_new",
      signingSecretRotatedAt: new Date(),
      revokedAt: null,
    });

    await expect(
      verifySignedRequest(
        requestDouble({
          headers: signedHeaders({
            secret: "old_secret",
            nonce: "old_secret_nonce",
          }),
        })
      )
    ).resolves.toMatchObject({
      ok: false,
      reasonCode: "signature_mismatch",
    });

    await expect(
      verifySignedRequest(
        requestDouble({
          headers: signedHeaders({
            secret: "new_secret",
            nonce: "new_secret_nonce",
          }),
        })
      )
    ).resolves.toMatchObject({ ok: true });
  });

  it("rotate-all rotates active clients and only returns current client secret", async () => {
    mockFindMany.mockResolvedValueOnce([
      { clientId: "client_abc", userId: 10, revokedAt: null },
      { clientId: "client_other", userId: 10, revokedAt: null },
    ]);
    mockFindFirst
      .mockResolvedValueOnce({
        id: 1,
        clientId: "client_abc",
        userId: 10,
        signingSecretEncrypted: "enc:old_secret",
        signingSecretVersion: "sec_old",
        revokedAt: null,
      })
      .mockResolvedValueOnce({
        id: 2,
        clientId: "client_other",
        userId: 10,
        signingSecretEncrypted: "enc:old_other",
        signingSecretVersion: "sec_other_old",
        revokedAt: null,
      });

    const result = await rotateAllSigningSecrets({
      userId: 10,
      currentClientId: "client_abc",
    });
    expect(result.count).toBe(2);
    expect(result.currentClient.secret).toBeTruthy();
    expect(
      result.clients.find((client) => client.client.clientId === "client_other")
        .secret
    ).toBeNull();
  });

  it("verifies websocket signed envelopes and exposes only inner payload", async () => {
    const payload = {
      type: "toolApprovalResponse",
      requestId: "r1",
      approved: true,
    };
    const body = JSON.stringify(payload);
    const path = "/api/agent-invocation/uuid";
    const headers = signedHeaders({
      method: "WS",
      path,
      body,
      nonce: "ws_nonce",
    });
    const message = JSON.stringify({
      type: "athenaSignedMessage",
      signatureVersion: SIGNATURE_VERSION,
      signed: {
        clientId: headers["X-Athena-Client-Id"],
        requestId: headers["X-Athena-Request-Id"],
        timestamp: headers["X-Athena-Timestamp"],
        nonce: headers["X-Athena-Nonce"],
        bodySha256: headers["X-Athena-Body-SHA256"],
        signature: headers["X-Athena-Signature"],
      },
      payload,
    });

    await expect(
      verifySignedWebSocketMessage(
        requestDouble({ method: "GET", path, body: "", headers }),
        message
      )
    ).resolves.toMatchObject({
      ok: true,
      payload,
      rawMessage: body,
    });
  });

  it("verifies websocket envelopes against stable path when connection has query params", async () => {
    const payload = {
      type: "clarificationResponse",
      requestId: "r2",
      answers: [],
    };
    const body = JSON.stringify(payload);
    const signedPath = "/api/agent-invocation/uuid";
    const requestPath =
      "/api/agent-invocation/uuid?token=token&resume=1&lastEventSeq=151";
    const headers = signedHeaders({
      method: "WS",
      path: signedPath,
      body,
      nonce: "ws_stable_path",
    });
    const message = JSON.stringify({
      type: "athenaSignedMessage",
      signatureVersion: SIGNATURE_VERSION,
      signed: {
        clientId: headers["X-Athena-Client-Id"],
        requestId: headers["X-Athena-Request-Id"],
        timestamp: headers["X-Athena-Timestamp"],
        nonce: headers["X-Athena-Nonce"],
        bodySha256: headers["X-Athena-Body-SHA256"],
        signature: headers["X-Athena-Signature"],
      },
      payload,
    });

    await expect(
      verifySignedWebSocketMessage(
        requestDouble({ method: "GET", path: requestPath, body: "", headers }),
        message
      )
    ).resolves.toMatchObject({
      ok: true,
      payload,
      rawMessage: body,
    });
  });

  it("temporarily accepts legacy websocket envelopes signed with query params", async () => {
    const payload = {
      type: "clarificationResponse",
      requestId: "r3",
      answers: [],
    };
    const body = JSON.stringify(payload);
    const path = "/api/agent-invocation/uuid?token=token&resume=1";
    const headers = signedHeaders({
      method: "WS",
      path,
      body,
      nonce: "ws_legacy_query_path",
    });
    const message = JSON.stringify({
      type: "athenaSignedMessage",
      signatureVersion: SIGNATURE_VERSION,
      signed: {
        clientId: headers["X-Athena-Client-Id"],
        requestId: headers["X-Athena-Request-Id"],
        timestamp: headers["X-Athena-Timestamp"],
        nonce: headers["X-Athena-Nonce"],
        bodySha256: headers["X-Athena-Body-SHA256"],
        signature: headers["X-Athena-Signature"],
      },
      payload,
    });

    await expect(
      verifySignedWebSocketMessage(
        requestDouble({ method: "GET", path, body: "", headers }),
        message
      )
    ).resolves.toMatchObject({
      ok: true,
      payload,
      rawMessage: body,
    });
  });

  it("rejects revoked websocket signed envelopes", async () => {
    mockFindFirst.mockResolvedValue({
      id: 1,
      clientId: "client_abc",
      userId: 10,
      signingSecretEncrypted: "enc:secret_abc",
      signingSecretVersion: SIGNATURE_VERSION,
      signingSecretRotatedAt: null,
      revokedAt: new Date(),
    });
    const payload = { type: "awaitingFeedback", feedback: "/exit" };
    const body = JSON.stringify(payload);
    const path = "/api/agent-invocation/uuid?token=token";
    const headers = signedHeaders({
      method: "WS",
      path,
      body,
      nonce: "ws_revoked",
    });

    await expect(
      verifySignedWebSocketMessage(
        requestDouble({ method: "GET", path, body: "", headers }),
        JSON.stringify({
          type: "athenaSignedMessage",
          signatureVersion: SIGNATURE_VERSION,
          signed: {
            clientId: headers["X-Athena-Client-Id"],
            requestId: headers["X-Athena-Request-Id"],
            timestamp: headers["X-Athena-Timestamp"],
            nonce: headers["X-Athena-Nonce"],
            bodySha256: headers["X-Athena-Body-SHA256"],
            signature: headers["X-Athena-Signature"],
          },
          payload,
        })
      )
    ).resolves.toMatchObject({
      ok: false,
      reasonCode: "client_revoked",
      payload,
    });
  });

  it("reports INVALID_SIGNATURE for enforced high-risk signature mismatch", async () => {
    process.env.NODE_ENV = "production";
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();
    await requireSignedHighRiskRequest(
      requestDouble({
        headers: signedHeaders({
          secret: "wrong_secret",
          nonce: "wrong_secret_nonce",
        }),
      }),
      response,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: INVALID_SIGNATURE_ERROR,
    });
  });
});
