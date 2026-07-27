/* eslint-env jest */

const mockIsMultiUserMode = jest.fn();
const mockFindByRecoveryHandle = jest.fn();
const mockValidateSession = jest.fn();
const mockEnableRecovery = jest.fn();
const mockTouchUserAction = jest.fn();
const mockMarkRecoveryUsed = jest.fn();
const mockFindAuthUser = jest.fn();
const mockCanLogin = jest.fn();
const mockEnsureShadowUser = jest.fn();
const mockTicketIssue = jest.fn();
const mockTicketConsume = jest.fn();
const mockRateLimitHit = jest.fn();
const mockGetClientContext = jest.fn();
const mockGetClientRecord = jest.fn();
const mockVerifySignedRequest = jest.fn();
const mockResumeSessionToken = jest.fn();
const mockEmitSemanticEvent = jest.fn();
const mockRecoveryMetric = jest.fn();
const mockRecoveryDuration = jest.fn();

const mockUser = {
  filterFields: jest.fn((user) => ({ id: user.id, authUserId: user.authUserId })),
};

jest.mock("../../utils/dataAccess", () => ({
  DataAccessCenter: {
    adminSystem: {
      isMultiUserMode: mockIsMultiUserMode,
      authIdentity: {
        findById: mockFindAuthUser,
        canLoginInCurrentEnvAsync: mockCanLogin,
        ensureShadowUser: mockEnsureShadowUser,
      },
      user: mockUser,
      authSession: {
        findByRecoveryHandle: mockFindByRecoveryHandle,
        validate: mockValidateSession,
        enableRecovery: mockEnableRecovery,
        touchUserAction: mockTouchUserAction,
        markRecoveryUsed: mockMarkRecoveryUsed,
      },
      realtimeTicket: {
        issue: mockTicketIssue,
        consume: mockTicketConsume,
      },
      emailVerificationRateLimit: {
        hit: mockRateLimitHit,
      },
    },
  },
}));

jest.mock("../../utils/middleware/validatedRequest", () => ({
  validatedRequest: jest.fn((_request, _response, next) => next()),
}));

jest.mock("../../utils/clientIdentity", () => ({
  getClientContext: mockGetClientContext,
  getClientRecord: mockGetClientRecord,
}));

jest.mock("../../utils/requestSigning", () => ({
  verifySignedRequest: mockVerifySignedRequest,
}));

jest.mock("../../utils/sessionIdle", () => ({
  resumeUserSessionToken: mockResumeSessionToken,
}));

jest.mock("../../utils/observability/semanticEvents", () => ({
  emitSemanticEvent: mockEmitSemanticEvent,
}));

jest.mock("../../utils/observability/metrics", () => ({
  metrics: {
    authSessionRecoveryAttempts: { inc: mockRecoveryMetric },
    authSessionRecoveryDuration: { observe: mockRecoveryDuration },
    authRouteGuardRecovery: { inc: jest.fn() },
  },
}));

const {
  authSessionRecoveryEndpoints,
} = require("../../endpoints/authSessionRecovery");

describe("auth session recovery endpoints", () => {
  const routes = new Map();

  beforeAll(() => {
    authSessionRecoveryEndpoints({
      post(path, ...handlers) {
        routes.set(path, handlers);
      },
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsMultiUserMode.mockResolvedValue(true);
    mockRateLimitHit.mockResolvedValue(false);
    mockCanLogin.mockResolvedValue(true);
    mockTouchUserAction.mockResolvedValue(1);
    mockMarkRecoveryUsed.mockResolvedValue({ count: 1 });
    mockResumeSessionToken.mockReturnValue("reissued-jwt");
    mockGetClientContext.mockImplementation((request, { user } = {}) => {
      request.clientContext ||= {
        clientId: "client-ios",
        platform: "ios",
        appVersion: "2.4.0",
        requestId: "request-1",
        legacy: false,
      };
      if (user) request.clientContext.userId = user.id;
      return request.clientContext;
    });
  });

  it("issues a one-time challenge for an active registered device", async () => {
    const session = activeSession();
    mockFindByRecoveryHandle.mockResolvedValue(session);
    mockValidateSession.mockResolvedValue({ valid: true, session });
    mockFindAuthUser.mockResolvedValue({ id: 7, status: "active" });
    mockEnsureShadowUser.mockResolvedValue({ id: 4, authUserId: 7 });
    mockGetClientRecord.mockResolvedValue(registeredClient());
    mockTicketIssue.mockResolvedValue({});

    const { request, response } = fakeRequest({
      body: { recoveryHandle: "recovery-handle", source: "route-guard" },
    });
    await route("/auth/session/recovery/start")(request, response);

    expect(response.statusCode).toBe(200);
    expect(response.payload).toEqual(
      expect.objectContaining({
        success: true,
        recoveryTicket: expect.any(String),
        signaturePolicy: "registered-device",
      })
    );
    expect(mockTicketIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({
          purpose: "session_recovery",
          claims: expect.objectContaining({
            sessionId: "sess-existing",
            clientId: "client-ios",
          }),
        }),
      })
    );
  });

  it("reissues the existing session after device signature verification", async () => {
    const session = activeSession();
    mockTicketConsume.mockResolvedValue({
      purpose: "session_recovery",
      resourceId: "auth-session-recovery",
      claims: {
        authUserId: 7,
        shadowUserId: 4,
        sessionId: "sess-existing",
        clientId: "client-ios",
        source: "api",
      },
    });
    mockValidateSession.mockResolvedValue({ valid: true, session });
    mockFindAuthUser.mockResolvedValue({ id: 7, status: "active" });
    mockEnsureShadowUser.mockResolvedValue({ id: 4, authUserId: 7 });
    mockGetClientRecord.mockResolvedValue(registeredClient());
    mockVerifySignedRequest.mockResolvedValue({
      ok: true,
      postQuantumVerified: false,
    });

    const { request, response } = fakeRequest({
      body: { recoveryTicket: "one-time-ticket" },
    });
    await route("/auth/session/recovery/finish")(request, response);

    expect(response.statusCode).toBe(200);
    expect(response.payload).toEqual({
      success: true,
      valid: true,
      user: { id: 4, authUserId: 7 },
      token: "reissued-jwt",
    });
    expect(mockResumeSessionToken).toHaveBeenCalledWith(
      expect.objectContaining({ id: 4 }),
      session
    );
    expect(mockTouchUserAction).toHaveBeenCalledWith("sess-existing");
  });

  it("refuses to downgrade a device with a registered PQ key", async () => {
    const session = activeSession();
    mockTicketConsume.mockResolvedValue({
      purpose: "session_recovery",
      resourceId: "auth-session-recovery",
      claims: {
        authUserId: 7,
        shadowUserId: 4,
        sessionId: "sess-existing",
        clientId: "client-ios",
        source: "api",
      },
    });
    mockValidateSession.mockResolvedValue({ valid: true, session });
    mockFindAuthUser.mockResolvedValue({ id: 7, status: "active" });
    mockEnsureShadowUser.mockResolvedValue({ id: 4, authUserId: 7 });
    mockGetClientRecord.mockResolvedValue({
      ...registeredClient(),
      pqPublicKey: "registered-pq-key",
    });
    mockVerifySignedRequest.mockResolvedValue({
      ok: true,
      postQuantumVerified: false,
    });

    const { request, response } = fakeRequest({
      body: { recoveryTicket: "one-time-ticket" },
    });
    await route("/auth/session/recovery/finish")(request, response);

    expect(response.statusCode).toBe(401);
    expect(response.payload).toMatchObject({
      success: false,
      reasonCode: "post_quantum_signature_required",
    });
    expect(mockResumeSessionToken).not.toHaveBeenCalled();
  });

  function route(path) {
    const handlers = routes.get(path);
    return handlers[handlers.length - 1];
  }
});

function activeSession() {
  return {
    sessionId: "sess-existing",
    subjectType: "user",
    authUserId: 7,
    clientId: "client-ios",
    authMode: "zk",
    tokenVersion: 1,
    revokedAt: null,
    idleExpiresAt: new Date(Date.now() + 60_000),
    absoluteExpiresAt: new Date(Date.now() + 120_000),
  };
}

function registeredClient() {
  return {
    clientId: "client-ios",
    publicKey: '{"kty":"EC"}',
    publicKeyAlgorithm: "ECDSA-P256-SHA256",
    pqPublicKey: null,
    revokedAt: null,
  };
}

function fakeRequest({ body }) {
  const request = {
    body,
    ip: "127.0.0.1",
    socket: {},
    get: jest.fn(() => null),
  };
  const response = {
    locals: {},
    statusCode: 200,
    payload: null,
    headers: {},
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
  return { request, response };
}
