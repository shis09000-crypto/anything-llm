const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const mockApiKeys = {
  create: jest.fn(),
  findFirst: jest.fn(),
  findMany: jest.fn(),
};

jest.mock("../../utils/prisma", () => ({
  api_keys: mockApiKeys,
}));

describe("ApiKey secret storage", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.ENCRYPTION_MASTER_KEY = TEST_KEY;
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_MASTER_KEY;
  });

  it("stores generated API keys encrypted and returns plaintext once", async () => {
    mockApiKeys.create.mockImplementation(async ({ data }) => ({
      id: 1,
      ...data,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    }));

    const { ApiKey } = require("../../models/apiKeys");
    const { isSecretEncrypted } = require("../../utils/security");
    const result = await ApiKey.create(7, "test key");

    expect(isSecretEncrypted(mockApiKeys.create.mock.calls[0][0].data.secret)).toBe(
      true
    );
    expect(result.apiKey.secret).not.toMatch(/^enc:v1:/);
    expect(result.apiKey.secretMasked).toBe(false);
  });

  it("validates encrypted stored API keys using a plaintext bearer key", async () => {
    const { saveSecret } = require("../../utils/security");
    const stored = {
      id: 1,
      secret: saveSecret("plain-api-key"),
      createdBy: null,
    };
    mockApiKeys.findFirst.mockResolvedValue(null);
    mockApiKeys.findMany.mockResolvedValue([stored]);

    const { ApiKey } = require("../../models/apiKeys");

    await expect(ApiKey.validateSecret("plain-api-key")).resolves.toBe(stored);
  });

  it("masks secrets when listing API keys", async () => {
    const { saveSecret } = require("../../utils/security");
    mockApiKeys.findMany.mockResolvedValue([
      { id: 1, name: "new", secret: saveSecret("new-secret") },
      { id: 2, name: "legacy", secret: "legacy-secret-value" },
    ]);

    const { ApiKey } = require("../../models/apiKeys");
    const result = await ApiKey.where({});

    expect(result[0].secret).toBe("********");
    expect(result[0].secretMasked).toBe(true);
    expect(result[1].secret).toBe("legacy-s...alue");
    expect(result[1].secretMasked).toBe(true);
  });
});
