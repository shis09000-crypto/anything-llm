/* global jest, describe, beforeEach, test, expect */

const mockRequestInternalService = jest.fn();

jest.mock("../../utils/microModules/internalClient", () => ({
  requestInternalService: mockRequestInternalService,
}));

const {
  IDENTITY_CAPABILITIES,
  assertPrincipalViaIdentity,
  attachClientContextViaIdentity,
  consumeRealtimeTicketViaIdentity,
  probeIdentityCapabilities,
  remoteIdentityOperationsEnabled,
  validateSessionViaIdentity,
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

  test("routes session validation through the declared AICP capability", async () => {
    mockRequestInternalService.mockResolvedValueOnce({
      active: true,
      principal: { sessionId: "session-1", userId: 10 },
    });
    const request = { header: () => "Bearer signed-session-token" };
    await expect(
      validateSessionViaIdentity({ request, env })
    ).resolves.toMatchObject({
      active: true,
    });
    expect(mockRequestInternalService).toHaveBeenCalledWith(
      expect.objectContaining({
        callerModule: "athena-api",
        targetModule: "authentication",
        capability: "identity.session.validate",
        contractVersion: "1.0",
        body: { token: "signed-session-token" },
      })
    );
  });

  test("asserts the principal and client in one read-only owner call", async () => {
    mockRequestInternalService.mockResolvedValueOnce({
      active: true,
      principal: { sessionId: "session-1", userId: 10 },
      user: { id: 10 },
    });
    const request = { header: () => "Bearer signed-session-token" };
    await expect(
      assertPrincipalViaIdentity({
        request,
        client: { clientId: "client-browser", platform: "web" },
        env,
      })
    ).resolves.toMatchObject({ active: true, user: { id: 10 } });
    expect(mockRequestInternalService).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "identity.assert",
        url: "https://identity:3026/internal/v1/principal/assert",
        body: {
          token: "signed-session-token",
          client: expect.objectContaining({ clientId: "client-browser" }),
        },
      })
    );
  });

  test("probes the complete capability matrix", async () => {
    mockRequestInternalService.mockResolvedValue({ available: true });
    await expect(
      probeIdentityCapabilities(env, Object.keys(IDENTITY_CAPABILITIES))
    ).resolves.toEqual({
      ready: true,
      capabilities: Object.fromEntries(
        Object.keys(IDENTITY_CAPABILITIES).map((capability) => [
          capability,
          "ready",
        ])
      ),
    });
    expect(mockRequestInternalService).toHaveBeenCalledTimes(
      Object.keys(IDENTITY_CAPABILITIES).length
    );
  });

  test("fails closed when a distributed consumer has no Identity endpoint", async () => {
    const missingUrlEnv = { ...env, ATHENA_IDENTITY_URL: "" };
    expect(remoteIdentityOperationsEnabled(missingUrlEnv)).toBe(true);
    await expect(
      validateSessionViaIdentity({
        request: { header: () => "Bearer signed-session-token" },
        env: missingUrlEnv,
      })
    ).rejects.toMatchObject({
      code: "identity_capability_unavailable",
      httpStatus: 503,
    });
    expect(mockRequestInternalService).not.toHaveBeenCalled();
  });
});
