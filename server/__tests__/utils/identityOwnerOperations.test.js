/* global jest, describe, beforeEach, test, expect */

const mockIntrospectSessionToken = jest.fn();
const mockRegisterClient = jest.fn();
const mockConsumeLocal = jest.fn();
const mockShadowGet = jest.fn();
const mockFilterFields = jest.fn((user) => ({
  id: user.id,
  username: user.username,
  role: user.role,
}));

jest.mock("../../utils/authz/sessionIntrospection", () => ({
  introspectSessionToken: mockIntrospectSessionToken,
}));
jest.mock("../../utils/clientIdentity", () => ({
  registerClient: mockRegisterClient,
}));
jest.mock("../../utils/dataAccess", () => ({
  DataAccessCenter: {
    adminSystem: { realtimeTicket: { consumeLocal: mockConsumeLocal } },
    authIdentity: {
      shadowUser: {
        _get: mockShadowGet,
        filterFields: mockFilterFields,
      },
    },
  },
}));

const {
  assertPrincipalFromSession,
  attachClientFromSession,
  consumeRealtimeTicketAsOwner,
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

  test("keeps the atomic ticket claim inside the Identity owner", async () => {
    mockConsumeLocal.mockResolvedValueOnce({ purpose: "broadcast" });
    await expect(
      consumeRealtimeTicketAsOwner("rt-secret")
    ).resolves.toMatchObject({ purpose: "broadcast" });
    expect(mockConsumeLocal).toHaveBeenCalledWith("rt-secret");
  });

  test("returns a filtered principal projection from the Identity owner", async () => {
    mockIntrospectSessionToken.mockResolvedValueOnce({
      success: true,
      active: true,
      principal: {
        subjectType: "user",
        userId: 10,
        clientId: "client-browser",
      },
    });
    mockRegisterClient.mockResolvedValueOnce({ revokedAt: null });
    mockShadowGet.mockResolvedValueOnce({
      id: 10,
      username: "owner",
      role: "admin",
      password: "must-not-leave-identity",
    });

    await expect(
      assertPrincipalFromSession({
        token: "signed-session-token",
        client: { clientId: "client-browser", platform: "web" },
      })
    ).resolves.toMatchObject({
      active: true,
      user: { id: 10, username: "owner", role: "admin" },
    });
    expect(mockFilterFields).toHaveBeenCalled();
  });
});
