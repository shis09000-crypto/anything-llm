const mockUserWhere = jest.fn();
const mockCryptoAccountEligibility = jest.fn();
const mockResolveApprovedConnection = jest.fn();
const mockRegistryGet = jest.fn();
const mockMetricInc = jest.fn();
const mockEmitSemanticEvent = jest.fn();

jest.mock("../../utils/dataAccess/lazyFacade", () => ({
  lazyDataAccessFacade: jest.fn(() => ({
    where: mockUserWhere,
  })),
}));

jest.mock("../../utils/cryptoAccount/accountHub", () => ({
  accountCryptoHubRegistry: {
    get: mockRegistryGet,
  },
}));

jest.mock("../../utils/cryptoAccount/connectionService", () => ({
  cryptoAccountEligibility: mockCryptoAccountEligibility,
  resolveApprovedConnection: mockResolveApprovedConnection,
}));

jest.mock("../../utils/observability/semanticEvents", () => ({
  emitSemanticEvent: mockEmitSemanticEvent,
}));

jest.mock("../../utils/observability/metrics", () => ({
  metrics: {
    cryptoAccountReads: {
      inc: mockMetricInc,
    },
  },
}));

jest.mock("../../utils/cryptoHub", () => ({
  cryptoDataHub: { kind: "shared-readonly-hub" },
}));

const {
  resolveCryptoHubForHttp,
} = require("../../utils/cryptoAccount/httpResolver");

describe("crypto account HTTP resolver", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      GATE_API_READONLY: "true",
      ATHENA_CRYPTO_LEGACY_FALLBACK: "true",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("prefers an approved account-scoped post-quantum connection", async () => {
    const eligibility = {
      available: true,
      credentialVersion: 3,
      rootKeyId: "root-key",
      domainKeyVersion: 2,
    };
    const resolved = { connection: { id: "connection-1" } };
    const accountHub = { kind: "account-hub" };
    mockCryptoAccountEligibility.mockResolvedValue(eligibility);
    mockResolveApprovedConnection.mockResolvedValue(resolved);
    mockRegistryGet.mockReturnValue(accountHub);

    await expect(
      resolveCryptoHubForHttp({ id: 4, authUserId: 1 })
    ).resolves.toEqual({
      hub: accountHub,
      mode: "account",
    });
    expect(mockResolveApprovedConnection).toHaveBeenCalledWith({
      user: { id: 4, authUserId: 1 },
      expectedCredentialVersion: 3,
      expectedRootKeyId: "root-key",
      expectedDomainKeyVersion: 2,
    });
    expect(mockUserWhere).not.toHaveBeenCalled();
  });

  test("allows an authenticated admin route actor to use the installation read-only hub", async () => {
    mockCryptoAccountEligibility.mockResolvedValue({
      available: false,
      reason: "user_root_not_initialized",
    });
    mockUserWhere.mockResolvedValue([
      {
        id: 3,
        authUserId: 2,
        status: "active",
        ownerType: "primary",
      },
    ]);

    await expect(
      resolveCryptoHubForHttp({ id: 4, authUserId: 1, role: "admin" })
    ).resolves.toEqual({
      hub: { kind: "shared-readonly-hub" },
      mode: "legacy-primary-owner",
    });
    expect(mockMetricInc).toHaveBeenCalledWith({
      function: "legacy_fallback",
      outcome: "fallback",
    });
    expect(mockEmitSemanticEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "crypto.account.legacy_fallback",
        sensitivity: "metadata_only",
      })
    );
  });

  test("does not expose the installation hub without an authenticated actor", async () => {
    mockCryptoAccountEligibility.mockResolvedValue({
      available: false,
      reason: "owner_unavailable",
    });

    await expect(resolveCryptoHubForHttp(null)).rejects.toMatchObject({
      code: "owner_unavailable",
    });
    expect(mockUserWhere).not.toHaveBeenCalled();
  });

  test("fails closed when the installation has no unique primary owner", async () => {
    mockCryptoAccountEligibility.mockResolvedValue({
      available: false,
      reason: "user_root_not_initialized",
    });
    mockUserWhere.mockResolvedValue([
      { id: 3, authUserId: 2 },
      { id: 5, authUserId: 6 },
    ]);

    await expect(
      resolveCryptoHubForHttp({ id: 4, authUserId: 1, role: "admin" })
    ).rejects.toMatchObject({
      code: "user_root_not_initialized",
    });
    expect(mockMetricInc).not.toHaveBeenCalled();
  });

  test("fails closed when the read-only fallback is disabled", async () => {
    process.env.ATHENA_CRYPTO_LEGACY_FALLBACK = "false";
    mockCryptoAccountEligibility.mockResolvedValue({
      available: false,
      reason: "crypto_account_not_bound",
    });

    await expect(
      resolveCryptoHubForHttp({ id: 4, authUserId: 1, role: "admin" })
    ).rejects.toMatchObject({
      code: "crypto_account_not_bound",
    });
    expect(mockUserWhere).not.toHaveBeenCalled();
  });
});
