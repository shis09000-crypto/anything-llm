/* global jest, describe, beforeEach, test, expect */

const mockIntrospectSessionToken = jest.fn();
const mockIntrospectSessionClaims = jest.fn();
const mockRegisterClient = jest.fn();
const mockConsumeLocal = jest.fn();
const mockTouchUserAction = jest.fn();
const mockShadowUserGet = jest.fn();
const mockShadowUserFilterFields = jest.fn((user) => user);
const mockVerifySignedDescriptorAsOwner = jest.fn();
const mockAppendSigningAuditAsOwner = jest.fn();

jest.mock("../../utils/authz/sessionIntrospection", () => ({
  introspectSessionClaims: mockIntrospectSessionClaims,
  introspectSessionToken: mockIntrospectSessionToken,
}));
jest.mock("../../utils/clientIdentity", () => ({
  registerClient: mockRegisterClient,
}));
jest.mock("../../utils/requestSigning", () => ({
  appendSigningAuditAsOwner: mockAppendSigningAuditAsOwner,
  verifySignedDescriptorAsOwner: mockVerifySignedDescriptorAsOwner,
}));
jest.mock("../../utils/dataAccess", () => ({
  DataAccessCenter: {
    adminSystem: {
      realtimeTicket: { consumeLocal: mockConsumeLocal },
      authSession: { touchUserAction: mockTouchUserAction },
    },
    authIdentity: {
      shadowUser: {
        _get: mockShadowUserGet,
        filterFields: mockShadowUserFilterFields,
      },
    },
  },
}));

const {
  assertPrincipalFromSession,
  attachClientFromSession,
  consumeRealtimeTicketAsOwner,
  touchSessionAsOwner,
  verifyRequestSigningAsOwner,
} = require("../../utils/authz/identityOwnerOperations");

describe("Identity owner operations", () => {
  beforeEach(() => jest.clearAllMocks());

  test("derives the user from authoritative session introspection", async () => {
    mockIntrospectSessionToken.mockResolvedValueOnce({
      active: true,
      principal: { userId: 10, clientId: "client-browser" },
    });
    mockRegisterClient.mockResolvedValueOnce({ revokedAt: null });

    await expect(
      attachClientFromSession({
        token: "signed-session-token",
        client: { clientId: "client-browser", platform: "web" },
      })
    ).resolves.toEqual({
      clientId: "client-browser",
      registered: true,
      revoked: false,
    });
    expect(mockRegisterClient).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 10,
        clientId: "client-browser",
        projectSync: false,
      })
    );
    expect(mockIntrospectSessionToken).toHaveBeenCalledWith(
      "signed-session-token",
      { requireClient: false }
    );
  });

  test("rejects a caller-controlled client that differs from the session", async () => {
    mockIntrospectSessionToken.mockResolvedValueOnce({
      active: true,
      principal: { userId: 10, clientId: "client-authorized" },
    });
    await expect(
      attachClientFromSession({
        token: "signed-session-token",
        client: { clientId: "client-forged", platform: "web" },
      })
    ).rejects.toMatchObject({ code: "session_client_mismatch" });
    expect(mockRegisterClient).not.toHaveBeenCalled();
  });

  test("asserts an existing client without re-registering it", async () => {
    mockIntrospectSessionToken.mockResolvedValueOnce({
      success: true,
      active: true,
      principal: {
        subjectType: "user",
        userId: 10,
        clientId: "client-browser",
      },
    });
    mockShadowUserGet.mockResolvedValueOnce({
      id: 10,
      username: "user",
      role: "admin",
    });

    await expect(
      assertPrincipalFromSession({
        token: "signed-session-token",
        client: { clientId: "client-browser", platform: "web" },
      })
    ).resolves.toMatchObject({
      active: true,
      user: { id: 10 },
      client: { clientId: "client-browser", registered: true },
    });
    expect(mockIntrospectSessionToken).toHaveBeenCalledWith(
      "signed-session-token",
      { requireClient: true }
    );
    expect(mockRegisterClient).not.toHaveBeenCalled();
  });

  test("combines signature verification and audit under one owner call", async () => {
    mockIntrospectSessionToken.mockResolvedValueOnce({
      active: true,
      principal: { userId: 10, clientId: "client-browser" },
    });
    mockVerifySignedDescriptorAsOwner.mockResolvedValueOnce({
      ok: true,
      signatureVersion: "device-p256-sha256-v1",
    });

    await expect(
      verifyRequestSigningAsOwner({
        token: "signed-session-token",
        descriptor: { originalUrl: "/workspace/new" },
      })
    ).resolves.toMatchObject({ result: { ok: true } });
    expect(mockAppendSigningAuditAsOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: expect.objectContaining({ userId: 10 }),
        result: expect.objectContaining({ ok: true }),
      })
    );
  });

  test("keeps the atomic ticket claim inside the Identity owner", async () => {
    mockConsumeLocal.mockResolvedValueOnce({ purpose: "broadcast" });
    await expect(
      consumeRealtimeTicketAsOwner("rt-secret")
    ).resolves.toMatchObject({ purpose: "broadcast" });
    expect(mockConsumeLocal).toHaveBeenCalledWith("rt-secret");
  });

  test("touches the session only inside the Identity owner", async () => {
    mockIntrospectSessionClaims.mockResolvedValueOnce({
      active: true,
      principal: { sessionId: "session-1", userId: 10 },
    });
    mockTouchUserAction.mockResolvedValueOnce(1);

    await expect(
      touchSessionAsOwner({ claims: { sid: "session-1", id: 10 } })
    ).resolves.toMatchObject({ touched: true });
    expect(mockTouchUserAction).toHaveBeenCalledWith("session-1");
  });
});
