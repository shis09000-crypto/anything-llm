const {
  configuredForBackground,
  startCryptoHubBackgroundRuntime,
} = require("../../../utils/cryptoHub/backgroundRuntime");

function configuredStatus(overrides = {}) {
  return {
    enabled: true,
    readOnly: true,
    gate: {
      configured: true,
      privateRest: "connected",
    },
    ...overrides,
  };
}

function mockHub(status = configuredStatus()) {
  return {
    getStatus: jest.fn(() => status),
    start: jest.fn(() => ({ success: true })),
    services: {
      equity: {
        prewarm: jest.fn(async () => ({
          success: true,
          history: {
            latestEquityUsd: 123.45,
            freshness: { latestSnapshotAt: 1_700_000_000_000 },
          },
        })),
      },
    },
    state: {
      markFromPayload: jest.fn(),
      markError: jest.fn(),
    },
  };
}

describe("Crypto Hub background runtime", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  test("skips when the background runtime is disabled", async () => {
    process.env.ATHENA_CRYPTO_ACCOUNT_SCOPED = "false";
    process.env.CRYPTO_HUB_BACKGROUND_ENABLED = "false";
    const hub = mockHub();

    const result = await startCryptoHubBackgroundRuntime({ hub });

    expect(result).toEqual({
      started: false,
      skipped: true,
      reason: "disabled",
    });
    expect(hub.start).not.toHaveBeenCalled();
  });

  test("disables the process-global private runtime by default in account-scoped mode", async () => {
    delete process.env.ATHENA_CRYPTO_ACCOUNT_SCOPED;
    delete process.env.CRYPTO_HUB_LEGACY_BACKGROUND_ENABLED;
    const hub = mockHub();

    const result = await startCryptoHubBackgroundRuntime({ hub });

    expect(result).toEqual({
      started: false,
      skipped: true,
      reason: "disabled",
    });
    expect(hub.start).not.toHaveBeenCalled();
  });

  test("skips when Gate is not configured for read-only private REST", async () => {
    process.env.CRYPTO_HUB_LEGACY_BACKGROUND_ENABLED = "true";
    const hub = mockHub(
      configuredStatus({
        enabled: true,
        readOnly: false,
        gate: { configured: false, privateRest: "disconnected" },
      })
    );

    const result = await startCryptoHubBackgroundRuntime({ hub });

    expect(result.started).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("gate_not_configured");
    expect(hub.start).not.toHaveBeenCalled();
  });

  test("starts shared polling and prewarms equity history when configured", async () => {
    process.env.CRYPTO_HUB_LEGACY_BACKGROUND_ENABLED = "true";
    const hub = mockHub();

    const result = await startCryptoHubBackgroundRuntime({ hub });

    expect(result.started).toBe(true);
    expect(hub.start).toHaveBeenCalledTimes(1);
    expect(hub.services.equity.prewarm).toHaveBeenCalledTimes(1);
    expect(hub.state.markFromPayload).toHaveBeenCalledWith("equity", {
      latestEquityUsd: 123.45,
      freshness: { latestSnapshotAt: 1_700_000_000_000 },
    });
  });

  test("requires enabled read-only Gate status", () => {
    expect(configuredForBackground(configuredStatus())).toBe(true);
    expect(
      configuredForBackground(
        configuredStatus({
          enabled: false,
        })
      )
    ).toBe(false);
    expect(
      configuredForBackground(
        configuredStatus({
          readOnly: false,
        })
      )
    ).toBe(false);
  });
});
