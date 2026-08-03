/* eslint-env jest */
process.env.STORAGE_DIR =
  process.env.STORAGE_DIR || "/tmp/anythingllm-validated-request-test";

const mockIsMultiUserMode = jest.fn();
const mockUserGet = jest.fn();
const mockFilterFields = jest.fn((user) => user);
const mockFindAuthUser = jest.fn();
const mockEnsureShadowUser = jest.fn();
const mockCanLoginInCurrentEnv = jest.fn();
const mockAttachAuthenticatedClientContext = jest.fn();
const mockGetClientRecord = jest.fn();
const mockGetClientContext = jest.fn();
const mockRemoteIdentityOperationsEnabled = jest.fn(() => false);
const mockAssertPrincipalViaIdentity = jest.fn();
const mockRequireSignedHighRiskRequest = jest.fn((_request, _response, next) =>
  next()
);

jest.mock("../../models/systemSettings", () => ({
  SystemSettings: {
    isMultiUserMode: (...args) => mockIsMultiUserMode(...args),
  },
}));

jest.mock("../../models/user", () => ({
  User: {
    _get: (...args) => mockUserGet(...args),
    filterFields: (...args) => mockFilterFields(...args),
  },
}));

jest.mock("../../models/authIdentity", () => ({
  AuthIdentity: {
    findById: (...args) => mockFindAuthUser(...args),
    ensureShadowUser: (...args) => mockEnsureShadowUser(...args),
    canLoginInCurrentEnvAsync: (...args) => mockCanLoginInCurrentEnv(...args),
  },
}));

jest.mock("../../utils/clientIdentity", () => ({
  attachAuthenticatedClientContext: (...args) =>
    mockAttachAuthenticatedClientContext(...args),
  getClientRecord: (...args) => mockGetClientRecord(...args),
  getClientContext: (...args) => mockGetClientContext(...args),
}));

jest.mock("../../utils/authz/identityOperationsClient", () => ({
  assertPrincipalViaIdentity: (...args) =>
    mockAssertPrincipalViaIdentity(...args),
  remoteIdentityOperationsEnabled: (...args) =>
    mockRemoteIdentityOperationsEnabled(...args),
}));

jest.mock("../../utils/requestSigning", () => ({
  CLIENT_REVOKED_ERROR: "CLIENT_REVOKED",
  requireSignedHighRiskRequest: (...args) =>
    mockRequireSignedHighRiskRequest(...args),
}));

const { makeJWT } = require("../../utils/http");
const { validatedRequest } = require("../../utils/middleware/validatedRequest");

function responseDouble() {
  return {
    locals: {},
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

function requestDouble(token) {
  return {
    header(name) {
      if (name === "Authorization") return `Bearer ${token}`;
      return null;
    },
  };
}

function sessionToken(payload = {}) {
  return makeJWT({
    id: 10,
    userId: 10,
    authUserId: 100,
    username: "user",
    role: "admin",
    allowedEnvs: ["development"],
    lastUserActionAt: Date.now(),
    ...payload,
  });
}

describe("validatedRequest client-bound sessions", () => {
  const originalJwtSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = "validated-request-secret";
    mockIsMultiUserMode.mockResolvedValue(true);
    mockUserGet.mockResolvedValue({
      id: 10,
      authUserId: 100,
      username: "user",
      role: "admin",
    });
    mockFindAuthUser.mockResolvedValue({ id: 100, username: "user" });
    mockCanLoginInCurrentEnv.mockResolvedValue(true);
    mockEnsureShadowUser.mockResolvedValue({
      id: 10,
      authUserId: 100,
      username: "user",
      role: "admin",
    });
    mockAttachAuthenticatedClientContext.mockResolvedValue({
      clientId: "client_abc",
      userId: 10,
      platform: "web",
      trustLevel: "medium",
      legacy: false,
    });
    mockGetClientRecord.mockResolvedValue({
      clientId: "client_abc",
      userId: 10,
      revokedAt: null,
    });
    mockGetClientContext.mockReturnValue({
      clientId: "client_abc",
      platform: "web",
      trustLevel: "low",
      legacy: false,
    });
    mockRemoteIdentityOperationsEnabled.mockReturnValue(false);
    mockAssertPrincipalViaIdentity.mockResolvedValue({
      success: true,
      active: true,
      principal: {
        subjectType: "user",
        userId: 10,
        authUserId: 100,
        sessionId: "sess_abc",
        clientId: "client_abc",
        role: "admin",
      },
      user: { id: 10, authUserId: 100, username: "user", role: "admin" },
    });
  });

  afterAll(() => {
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  });

  it("rejects a client-bound token when the bound device is revoked", async () => {
    mockGetClientRecord.mockResolvedValueOnce({
      clientId: "client_abc",
      userId: 10,
      revokedAt: new Date(),
    });
    const response = responseDouble();
    const next = jest.fn();

    await validatedRequest(
      requestDouble(
        sessionToken({ clientId: "client_abc", sessionId: "sess_abc" })
      ),
      response,
      next
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: "CLIENT_REVOKED",
      reasonCode: "client_revoked",
    });
    expect(response.locals.authFailureReason).toBe("client_revoked");
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a client-bound token when request client id differs", async () => {
    mockAttachAuthenticatedClientContext.mockResolvedValueOnce({
      clientId: "client_other",
      userId: 10,
      platform: "web",
      trustLevel: "medium",
      legacy: false,
    });
    const response = responseDouble();
    const next = jest.fn();

    await validatedRequest(
      requestDouble(
        sessionToken({ clientId: "client_abc", sessionId: "sess_abc" })
      ),
      response,
      next
    );

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({
      error: "Session client mismatch.",
      reasonCode: "session_client_mismatch",
    });
    expect(response.locals.authFailureReason).toBe("session_client_mismatch");
    expect(next).not.toHaveBeenCalled();
  });

  it("keeps older unbound tokens compatible", async () => {
    const response = responseDouble();
    const next = jest.fn();

    await validatedRequest(requestDouble(sessionToken()), response, next);

    expect(mockRequireSignedHighRiskRequest).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it("returns a stable reason code when an idle session expires", async () => {
    const response = responseDouble();
    const next = jest.fn();

    await validatedRequest(
      requestDouble(
        sessionToken({
          lastUserActionAt: Date.now() - 49 * 60 * 60 * 1000,
        })
      ),
      response,
      next
    );

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Session expired due to inactivity.",
        idleRemainingMs: 0,
        reasonCode: "session_idle_expired",
      })
    );
    expect(response.locals.authFailureReason).toBe("session_idle_expired");
    expect(next).not.toHaveBeenCalled();
  });

  it("returns retryable 503 instead of rejecting when identity storage is unavailable", async () => {
    const error = new Error("Unknown argument publicKeyAlgorithm");
    error.name = "PrismaClientValidationError";
    mockAttachAuthenticatedClientContext.mockRejectedValueOnce(error);
    const response = responseDouble();
    const next = jest.fn();

    await expect(
      validatedRequest(requestDouble(sessionToken()), response, next)
    ).resolves.toBe(response);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: "authentication_state_unavailable",
      retryable: true,
      reasonCode: "authentication_state_unavailable",
    });
    expect(response.locals.authFailureReason).toBe(
      "authentication_state_unavailable"
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("uses the Identity principal capability in distributed runtimes", async () => {
    mockRemoteIdentityOperationsEnabled.mockReturnValue(true);
    const request = requestDouble(sessionToken({ sessionId: "sess_abc" }));
    const response = responseDouble();
    const next = jest.fn();

    await validatedRequest(request, response, next);

    expect(mockAssertPrincipalViaIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        request,
        client: expect.objectContaining({ clientId: "client_abc" }),
      })
    );
    expect(response.locals.user).toMatchObject({ id: 10, role: "admin" });
    expect(response.locals.authSession).toMatchObject({
      sessionId: "sess_abc",
      clientId: "client_abc",
    });
    expect(mockUserGet).not.toHaveBeenCalled();
    expect(mockRequireSignedHighRiskRequest).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});
