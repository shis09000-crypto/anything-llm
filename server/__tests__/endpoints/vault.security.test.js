const bcrypt = require("bcryptjs");

const mockLogEvent = jest.fn();
const mockUserGet = jest.fn();
const mockVaultGet = jest.fn();
const mockVaultList = jest.fn();
const mockVaultDelete = jest.fn();

jest.mock("../../models/eventLogs", () => ({
  EventLogs: {
    logEvent: (...args) => mockLogEvent(...args),
  },
}));

jest.mock("../../models/user", () => ({
  User: {
    _get: (...args) => mockUserGet(...args),
  },
}));

jest.mock("../../models/vaultItem", () => ({
  VaultItem: {
    list: (...args) => mockVaultList(...args),
    get: (...args) => mockVaultGet(...args),
    delete: (...args) => mockVaultDelete(...args),
    createOrUpdate: jest.fn(),
  },
}));

jest.mock("../../utils/middleware/validatedRequest", () => ({
  validatedRequest: (_request, _response, next) => next?.(),
}));

jest.mock("../../utils/clientIdentity", () => ({
  getClientContext: (request) => request.clientContext,
}));

const {
  revokeVaultAccessGrants,
} = require("../../utils/authz/vaultAccessGrants");
const { vaultEndpoints } = require("../../endpoints/vault");

function routeRegistry() {
  const routes = {};
  const app = {};
  for (const method of ["get", "post", "delete"]) {
    app[method] = (path, _middleware, handler) => {
      routes[`${method.toUpperCase()} ${path}`] = handler;
    };
  }
  vaultEndpoints(app);
  return routes;
}

function responseDouble() {
  return {
    locals: { user: { id: 10 } },
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
}

function requestDouble({ body = {}, vaultGrant = null } = {}) {
  const authorization = "Bearer active-session";
  return {
    body,
    params: { itemId: "vlt_1" },
    query: {},
    signedRequest: {
      ok: true,
      requestId: "req_1",
      signatureVersion: "v2-device-p256",
    },
    clientContext: {
      userId: 10,
      clientId: "client_abc",
      legacy: false,
      requestId: "req_1",
    },
    header(name) {
      if (name === "Authorization") return authorization;
      return name === "X-Athena-Vault-Grant" ? vaultGrant : null;
    },
    headers: {
      authorization,
      ...(vaultGrant ? { "x-athena-vault-grant": vaultGrant } : {}),
    },
  };
}

describe("vault security endpoints", () => {
  const originalGrantRequired = process.env.VAULT_GRANT_REQUIRED;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VAULT_GRANT_REQUIRED = "true";
    revokeVaultAccessGrants({ userId: 10 });
    mockLogEvent.mockResolvedValue({ eventLog: { id: 1 }, message: null });
    mockUserGet.mockResolvedValue({
      id: 10,
      password: bcrypt.hashSync("correct-password", 10),
    });
    mockVaultGet.mockResolvedValue({
      itemId: "vlt_1",
      itemType: "api_key",
      cryptoVersion: "athena-vault-item:v1",
      encryptedPayload: { ciphertext: "cipher" },
    });
    mockVaultList.mockResolvedValue([]);
    mockVaultDelete.mockResolvedValue(true);
  });

  afterAll(() => {
    if (originalGrantRequired === undefined)
      delete process.env.VAULT_GRANT_REQUIRED;
    else process.env.VAULT_GRANT_REQUIRED = originalGrantRequired;
  });

  it("blocks encrypted vault item reads without a fresh grant", async () => {
    const routes = routeRegistry();
    const response = responseDouble();

    await routes["GET /vault/items/:itemId"](requestDouble(), response);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: "vault_access_grant_required",
    });
    expect(mockVaultGet).not.toHaveBeenCalled();
  });

  it("issues a password-backed grant and allows the same client to read vault detail", async () => {
    const routes = routeRegistry();
    const grantResponse = responseDouble();

    await routes["POST /vault/reauth/password"](
      requestDouble({ body: { currentPassword: "correct-password" } }),
      grantResponse
    );

    const grantPayload = grantResponse.json.mock.calls[0][0];
    expect(grantResponse.status).toHaveBeenCalledWith(200);
    expect(grantPayload.vaultGrant).toBeTruthy();

    const readResponse = responseDouble();
    await routes["GET /vault/items/:itemId"](
      requestDouble({ vaultGrant: grantPayload.vaultGrant }),
      readResponse
    );

    expect(readResponse.status).toHaveBeenCalledWith(200);
    expect(readResponse.json).toHaveBeenCalledWith({
      success: true,
      item: expect.objectContaining({ itemId: "vlt_1" }),
    });
    expect(mockVaultGet).toHaveBeenCalledWith({
      userId: 10,
      itemId: "vlt_1",
      includeEncryptedPayload: true,
    });
  });
});
