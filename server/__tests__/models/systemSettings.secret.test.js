const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const mockSystemSettings = {
  findFirst: jest.fn(),
  upsert: jest.fn(),
};

jest.mock("../../utils/prisma", () => ({
  system_settings: mockSystemSettings,
}));

describe("SystemSettings secret storage", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.ENCRYPTION_MASTER_KEY = TEST_KEY;
    mockSystemSettings.findFirst.mockResolvedValue(null);
    mockSystemSettings.upsert.mockImplementation(async ({ create }) => create);
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_MASTER_KEY;
  });

  it("encrypts Gmail and Google Calendar bridge API keys", async () => {
    const { SystemSettings } = require("../../models/systemSettings");
    const { isSecretEncrypted, readSecret } = require("../../utils/security");

    await SystemSettings.updateSettings({
      gmail_agent_config: JSON.stringify({
        deploymentId: "gmail-deployment",
        apiKey: "gmail-key",
      }),
      google_calendar_agent_config: JSON.stringify({
        deploymentId: "calendar-deployment",
        apiKey: "calendar-key",
      }),
    });

    const storedValues = mockSystemSettings.upsert.mock.calls.map((call) =>
      JSON.parse(call[0].create.value)
    );

    expect(isSecretEncrypted(storedValues[0].apiKey)).toBe(true);
    expect(readSecret(storedValues[0].apiKey)).toBe("gmail-key");
    expect(isSecretEncrypted(storedValues[1].apiKey)).toBe(true);
    expect(readSecret(storedValues[1].apiKey)).toBe("calendar-key");
  });

  it("encrypts Outlook client secret and OAuth tokens", async () => {
    const { SystemSettings } = require("../../models/systemSettings");
    const { isSecretEncrypted, readSecret } = require("../../utils/security");

    await SystemSettings.updateSettings({
      outlook_agent_config: JSON.stringify({
        clientId: "client-id",
        tenantId: "tenant-id",
        clientSecret: "client-secret",
        accessToken: "access-token",
        refreshToken: "refresh-token",
      }),
    });

    const stored = JSON.parse(mockSystemSettings.upsert.mock.calls[0][0].create.value);

    expect(isSecretEncrypted(stored.clientSecret)).toBe(true);
    expect(isSecretEncrypted(stored.accessToken)).toBe(true);
    expect(isSecretEncrypted(stored.refreshToken)).toBe(true);
    expect(readSecret(stored.clientSecret)).toBe("client-secret");
    expect(readSecret(stored.accessToken)).toBe("access-token");
    expect(readSecret(stored.refreshToken)).toBe("refresh-token");
  });

  it("encrypts and reads the hub API key", async () => {
    const { SystemSettings } = require("../../models/systemSettings");
    const { isSecretEncrypted } = require("../../utils/security");

    await SystemSettings.updateSettings({ hub_api_key: "hub-key" });
    const stored = mockSystemSettings.upsert.mock.calls[0][0].create.value;
    expect(isSecretEncrypted(stored)).toBe(true);

    mockSystemSettings.findFirst.mockResolvedValue({ value: stored });
    await expect(SystemSettings.hubSettings()).resolves.toEqual({
      connectionKey: "hub-key",
    });
  });
});
