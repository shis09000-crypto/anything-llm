/* global jest, describe, beforeEach, test, expect */

const mockRequestInternalService = jest.fn();

jest.mock("../../utils/microModules/internalClient", () => ({
  requestInternalService: mockRequestInternalService,
}));

const {
  assertPrincipalViaIdentity,
  attachClientContextViaIdentity,
  consumeRealtimeTicketViaIdentity,
  readUserStateViaIdentity,
  remoteIdentityOperationsEnabled,
} = require("../../utils/authz/identityOperationsClient");

describe("Identity owner operations client", () => {
  const env = {
    NODE_ENV: "production",
    ATHENA_RUNTIME_TOPOLOGY: "micro-modules",
    ATHENA_RUNTIME_ROLE: "api",
    ATHENA_IDENTITY_URL: "https://identity:3026",
  };

  beforeEach(() => jest.clearAllMocks());

  test("sends authenticated client metadata to the Identity owner", async () => {
    mockRequestInternalService.mockResolvedValueOnce({
      success: true,
      registered: true,
    });
    const request = {
      header: () => "Bearer signed-session-token",
    };
    await expect(
      attachClientContextViaIdentity({
        request,
        context: {
          userId: 10,
          clientId: "client-browser",
          platform: "web",
          appVersion: "2.5",
          capabilities: { clipboard: true },
        },
        env,
      })
    ).resolves.toMatchObject({ registered: true });

    expect(mockRequestInternalService).toHaveBeenCalledWith(
      expect.objectContaining({
        callerRole: "api",
        url: "https://identity:3026/internal/v1/client-identity/attach",
        body: {
          token: "signed-session-token",
          client: expect.objectContaining({
            clientId: "client-browser",
            platform: "web",
          }),
        },
      })
    );
    expect(
      mockRequestInternalService.mock.calls[0][0].body.client
    ).not.toHaveProperty("userId");
  });

  test("asserts the principal through the Identity owner", async () => {
    mockRequestInternalService.mockResolvedValueOnce({
      success: true,
      active: true,
      principal: { userId: 10, clientId: "client-browser" },
    });
    const request = {
      header: () => "Bearer signed-session-token",
    };

    await expect(
      assertPrincipalViaIdentity({
        request,
        client: { clientId: "client-browser", platform: "web" },
        authoritative: true,
        env,
      })
    ).resolves.toMatchObject({ active: true });

    expect(mockRequestInternalService).toHaveBeenCalledWith(
      expect.objectContaining({
        callerModule: "athena-api",
        targetModule: "authentication",
        capability: "identity.assert",
        url: "https://identity:3026/internal/v1/principal/assert",
        body: expect.objectContaining({
          token: "signed-session-token",
          authoritative: true,
          client: expect.objectContaining({ clientId: "client-browser" }),
        }),
      })
    );
  });

  test("consumes a one-time realtime ticket through Identity", async () => {
    mockRequestInternalService.mockResolvedValueOnce({
      success: true,
      entry: { purpose: "broadcast", expiresAt: Date.now() + 30_000 },
    });
    await expect(
      consumeRealtimeTicketViaIdentity("rt-secret", {
        ...env,
        ATHENA_RUNTIME_ROLE: "realtime-gateway",
      })
    ).resolves.toMatchObject({ purpose: "broadcast" });
    expect(mockRequestInternalService).toHaveBeenCalledWith(
      expect.objectContaining({
        callerRole: "realtime-gateway",
        url: "https://identity:3026/internal/v1/realtime/tickets/consume",
        body: { ticket: "rt-secret" },
      })
    );
  });

  test("never loops remote operations from the Identity owner", () => {
    expect(
      remoteIdentityOperationsEnabled({
        ...env,
        ATHENA_RUNTIME_ROLE: "identity",
      })
    ).toBe(false);
  });

  test("does not turn a terminal Identity user-state response into empty state", async () => {
    mockRequestInternalService.mockResolvedValueOnce({
      success: true,
      active: false,
      reasonCode: "session_revoked",
    });
    const request = {
      header: () => "Bearer revoked-session-token",
    };

    await expect(
      readUserStateViaIdentity({
        request,
        namespaces: ["workspace"],
        scopes: ["default"],
        env,
      })
    ).rejects.toMatchObject({
      code: "session_revoked",
      httpStatus: 401,
      terminalAuthFailure: true,
    });
  });
});
