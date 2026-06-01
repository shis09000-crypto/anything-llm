const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const mockBrowserExtensionApiKeys = {
  create: jest.fn(),
  findUnique: jest.fn(),
  findMany: jest.fn(),
};

jest.mock("../../utils/prisma", () => ({
  browser_extension_api_keys: mockBrowserExtensionApiKeys,
}));

jest.mock("../../models/systemSettings", () => ({
  SystemSettings: {
    isMultiUserMode: jest.fn().mockResolvedValue(false),
  },
}));

describe("BrowserExtensionApiKey secret storage", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.ENCRYPTION_MASTER_KEY = TEST_KEY;
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_MASTER_KEY;
  });

  it("stores generated browser extension keys encrypted and returns plaintext once", async () => {
    mockBrowserExtensionApiKeys.create.mockImplementation(async ({ data }) => ({
      id: 1,
      ...data,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    }));

    const { BrowserExtensionApiKey } = require("../../models/browserExtensionApiKey");
    const { isSecretEncrypted } = require("../../utils/security");
    const result = await BrowserExtensionApiKey.create(7);

    expect(
      isSecretEncrypted(mockBrowserExtensionApiKeys.create.mock.calls[0][0].data.key)
    ).toBe(true);
    expect(result.apiKey.key).toMatch(/^brx-/);
    expect(result.apiKey.keyMasked).toBe(false);
  });

  it("validates encrypted stored browser keys using a plaintext bearer key", async () => {
    const { saveSecret } = require("../../utils/security");
    const stored = {
      id: 1,
      key: saveSecret("brx-plain-browser-key"),
      user_id: null,
    };
    mockBrowserExtensionApiKeys.findUnique.mockResolvedValue(null);
    mockBrowserExtensionApiKeys.findMany.mockResolvedValue([stored]);

    const { BrowserExtensionApiKey } = require("../../models/browserExtensionApiKey");

    await expect(
      BrowserExtensionApiKey.validate("brx-plain-browser-key")
    ).resolves.toBe(stored);
  });

  it("masks browser keys when listing", async () => {
    const { saveSecret } = require("../../utils/security");
    mockBrowserExtensionApiKeys.findMany.mockResolvedValue([
      { id: 1, key: saveSecret("brx-new-secret") },
      { id: 2, key: "brx-legacy-secret-value" },
    ]);

    const { BrowserExtensionApiKey } = require("../../models/browserExtensionApiKey");
    const result = await BrowserExtensionApiKey.where({});

    expect(result[0].key).toBe("********");
    expect(result[0].keyMasked).toBe(true);
    expect(result[1].key).toBe("brx-lega...alue");
    expect(result[1].keyMasked).toBe(true);
  });
});
