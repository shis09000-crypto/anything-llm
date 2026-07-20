const mockIsMultiUserMode = jest.fn();
const mockSessionValidate = jest.fn();
const mockVerifySingleUserVersion = jest.fn();
const mockUserGet = jest.fn();
const mockFilterFields = jest.fn((user) => user);
const mockFindAuthUser = jest.fn();
const mockBootstrapAuthUser = jest.fn();
const mockCanLogin = jest.fn();
const mockEnsureShadowUser = jest.fn();
const mockDecodeJwt = jest.fn();
const mockGetClientContext = jest.fn();
const mockGetClientRecord = jest.fn();
const mockRealtimeTickets = new Map();
const mockTicketIssue = jest.fn(async ({ ticket, entry }) => {
  mockRealtimeTickets.set(ticket, entry);
  return entry;
});
const mockTicketConsume = jest.fn(async (ticket) => {
  const entry = mockRealtimeTickets.get(ticket) || null;
  mockRealtimeTickets.delete(ticket);
  return entry;
});

jest.mock("../../utils/dataAccess", () => ({
  DataAccessCenter: {
    adminSystem: {
      isMultiUserMode: (...args) => mockIsMultiUserMode(...args),
      authSession: {
        validate: (...args) => mockSessionValidate(...args),
        verifySingleUserAuthVersion: (...args) =>
          mockVerifySingleUserVersion(...args),
      },
      realtimeTicket: {
        issue: (...args) => mockTicketIssue(...args),
        consume: (...args) => mockTicketConsume(...args),
      },
    },
    authIdentity: {
      model: {
        findById: (...args) => mockFindAuthUser(...args),
        bootstrapAuthUserFromShadow: (...args) =>
          mockBootstrapAuthUser(...args),
        canLoginInCurrentEnvAsync: (...args) => mockCanLogin(...args),
        ensureShadowUser: (...args) => mockEnsureShadowUser(...args),
      },
      shadowUser: {
        _get: (...args) => mockUserGet(...args),
        filterFields: (...args) => mockFilterFields(...args),
      },
    },
  },
}));

jest.mock("../../utils/http", () => ({
  decodeJWT: (...args) => mockDecodeJwt(...args),
}));

jest.mock("../../utils/codexDevAuthBypass", () => ({
  codexDevAuthUser: jest.fn(() => null),
  isCodexDevAuthBypassEnabled: jest.fn(() => false),
}));

jest.mock("../../utils/clientIdentity", () => ({
  getClientContext: (...args) => mockGetClientContext(...args),
  getClientRecord: (...args) => mockGetClientRecord(...args),
}));

jest.mock("../../utils/sessionIdle", () => ({
  jwtIdleState: jest.fn(() => ({ idleExpired: false })),
  sessionClientIdFromToken: jest.fn((claims) => claims?.clientId || null),
}));

const {
  authenticateRealtimeRequest,
  issueRealtimeTicket,
  _internals,
} = require("../../utils/authz/realtimePrincipal");

function request({
  token = "session-token",
  query = {},
  clientId = "client-1",
} = {}) {
  return {
    query,
    clientId,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    header(name) {
      return name === "Authorization" ? this.headers.authorization : null;
    },
  };
}

describe("authoritative realtime principals", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    mockRealtimeTickets.clear();
    process.env.NODE_ENV = "production";
    process.env.ATHENA_REALTIME_REQUIRE_SESSION = "true";
    process.env.ATHENA_REALTIME_LEGACY_QUERY_TOKEN = "false";
    mockIsMultiUserMode.mockResolvedValue(true);
    mockDecodeJwt.mockReturnValue({
      id: 7,
      authUserId: 70,
      sid: "sess-1",
      tokenVersion: 2,
      clientId: "client-1",
      lastUserActionAt: Date.now(),
      p: "legacy-password-material-must-not-propagate",
    });
    mockSessionValidate.mockResolvedValue({
      valid: true,
      session: { sessionId: "sess-1", authUserId: 70, tokenVersion: 2 },
    });
    mockUserGet.mockResolvedValue({ id: 7, authUserId: 70, role: "admin" });
    mockFindAuthUser.mockResolvedValue({ id: 70 });
    mockCanLogin.mockResolvedValue(true);
    mockEnsureShadowUser.mockResolvedValue({
      id: 7,
      authUserId: 70,
      role: "admin",
    });
    mockGetClientContext.mockImplementation((req, { user } = {}) => ({
      clientId: req.clientId,
      userId: user?.id || null,
      platform: "web",
      legacy: false,
    }));
    mockGetClientRecord.mockResolvedValue({
      userId: 7,
      clientId: "client-1",
      revokedAt: null,
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("issues a client-bound one-time ticket and rejects replay", async () => {
    const issueRequest = request();
    const ticket = await issueRealtimeTicket({
      request: issueRequest,
      response: {
        locals: {
          multiUserMode: true,
          user: { id: 7, authUserId: 70, role: "admin" },
        },
      },
      purpose: "agent",
      resourceId: "invocation-1",
    });
    const socketRequest = request({
      token: null,
      query: { realtimeTicket: ticket.ticket },
    });

    const principal = await authenticateRealtimeRequest({
      request: socketRequest,
      purpose: "agent",
      resourceId: "invocation-1",
    });

    expect(principal.user).toEqual(
      expect.objectContaining({ id: 7, authUserId: 70 })
    );
    expect(principal.source).toBe("one_time_ticket");
    expect(mockTicketIssue.mock.calls[0][0].entry.claims).not.toHaveProperty(
      "p"
    );
    await expect(
      authenticateRealtimeRequest({
        request: request({
          token: null,
          query: { realtimeTicket: ticket.ticket },
        }),
        purpose: "agent",
        resourceId: "invocation-1",
      })
    ).rejects.toMatchObject({ code: "realtime_ticket_expired" });
  });

  it("rejects legacy query JWTs when the compatibility flag is off", async () => {
    await expect(
      authenticateRealtimeRequest({
        request: request({ token: null, query: { token: "legacy-jwt" } }),
        purpose: "broadcast",
      })
    ).rejects.toMatchObject({ code: "realtime_session_required" });
  });

  it("rejects a revoked authoritative session", async () => {
    mockSessionValidate.mockResolvedValueOnce({
      valid: false,
      code: "session_revoked",
      session: { sessionId: "sess-1", revokedAt: new Date() },
    });

    await expect(
      authenticateRealtimeRequest({
        request: request(),
        purpose: "broadcast",
      })
    ).rejects.toMatchObject({ code: "session_revoked" });
  });

  it("rejects a ticket replayed from a different client", async () => {
    const issued = await issueRealtimeTicket({
      request: request({ clientId: "client-1" }),
      response: {
        locals: {
          multiUserMode: true,
          user: { id: 7, authUserId: 70, role: "admin" },
        },
      },
      purpose: "broadcast",
    });

    await expect(
      authenticateRealtimeRequest({
        request: request({
          token: null,
          clientId: "client-2",
          query: { realtimeTicket: issued.ticket },
        }),
        purpose: "broadcast",
      })
    ).rejects.toMatchObject({ code: "realtime_session_client_mismatch" });
  });
});
