/* global jest, describe, beforeEach, test, expect */

const mockRemoteCustodyStatus = jest.fn();
const mockRemoteKeyCustodyEnabled = jest.fn();

jest.mock("../../utils/security/keyCustody/remoteClient", () => ({
  remoteCustodyStatus: mockRemoteCustodyStatus,
  remoteKeyCustodyEnabled: mockRemoteKeyCustodyEnabled,
}));

const {
  resetSecurityStateForTests,
  securityState,
} = require("../../utils/security/keyRuntimeState");
const {
  bootstrapSecurityContext,
} = require("../../utils/security/keyLifecycle");

describe("remote Key Custody lifecycle cutover", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetSecurityStateForTests();
    mockRemoteKeyCustodyEnabled.mockReturnValue(true);
    delete process.env.ATHENA_KEY_CUSTODY_BOOTSTRAP_ATTEMPTS;
    delete process.env.ATHENA_KEY_CUSTODY_BOOTSTRAP_RETRY_MS;
  });

  test("marks the remote service authoritative without local key material", async () => {
    mockRemoteCustodyStatus.mockResolvedValue({
      ok: true,
      providerType: "secret-file",
      mutable: false,
      attested: false,
      decryptOnlyKeyCount: 0,
    });

    await expect(
      bootstrapSecurityContext({ runtimeRole: "api" })
    ).resolves.toMatchObject({
      status: "ready",
      quarantined: false,
      runtimeRole: "api",
      provider: { remote: true, providerType: "secret-file" },
      activeKey: null,
      domains: [
        expect.objectContaining({
          domain: "key-custody-service",
          state: "remote-authoritative",
        }),
      ],
    });
    expect(securityState().writeBarrier).toBe(false);
  });

  test("fails closed when the remote authority is unavailable", async () => {
    mockRemoteCustodyStatus.mockRejectedValue(
      Object.assign(new Error("unavailable"), {
        code: "REMOTE_KEY_CUSTODY_UNHEALTHY",
      })
    );

    await expect(
      bootstrapSecurityContext({ runtimeRole: "api" })
    ).resolves.toMatchObject({
      status: "quarantined",
      quarantined: true,
      reason: "REMOTE_KEY_CUSTODY_UNHEALTHY",
      provider: { remote: true },
    });
  });

  test("recovers from a transient remote authority startup race", async () => {
    process.env.ATHENA_KEY_CUSTODY_BOOTSTRAP_ATTEMPTS = "3";
    process.env.ATHENA_KEY_CUSTODY_BOOTSTRAP_RETRY_MS = "10";
    mockRemoteCustodyStatus
      .mockRejectedValueOnce(
        Object.assign(new Error("dns_not_ready"), { code: "ENOTFOUND" })
      )
      .mockResolvedValueOnce({
        ok: true,
        providerType: "secret-file",
        mutable: false,
        attested: false,
        decryptOnlyKeyCount: 0,
      });

    await expect(
      bootstrapSecurityContext({ runtimeRole: "api" })
    ).resolves.toMatchObject({
      status: "ready",
      quarantined: false,
      provider: { remote: true, providerType: "secret-file" },
    });
    expect(mockRemoteCustodyStatus).toHaveBeenCalledTimes(2);
  });
});
