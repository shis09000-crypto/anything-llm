/* eslint-env jest */
const mockPrismaUsersFindUnique = jest.fn();
const mockTrustedLoginDeviceFindFirst = jest.fn();
const mockTrustedLoginDeviceUpdate = jest.fn();
const mockZkLoginAttemptCreate = jest.fn();
const mockZkLoginAttemptDeleteMany = jest.fn();
const mockOpaqueStartLogin = jest.fn();
const mockSystemSettingsFindFirst = jest.fn();
const mockSystemSettingsUpsert = jest.fn();
const mockReadSecretAsync = jest.fn();
const mockSaveSecretAsync = jest.fn();

jest.mock("../../utils/prisma", () => ({
  users: { findUnique: mockPrismaUsersFindUnique },
  system_settings: {
    findFirst: mockSystemSettingsFindFirst,
    upsert: mockSystemSettingsUpsert,
  },
}));
jest.mock("../../utils/security", () => ({
  readSecretAsync: mockReadSecretAsync,
  saveSecretAsync: mockSaveSecretAsync,
}));
jest.mock("../../utils/authPrisma", () => ({
  passkeyChallenge: {
    create: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
    findFirst: jest.fn(),
  },
  passkeyCredential: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  },
  trustedLoginDevice: {
    findFirst: mockTrustedLoginDeviceFindFirst,
    findMany: jest.fn(),
    update: mockTrustedLoginDeviceUpdate,
    upsert: jest.fn(),
  },
  zkLoginAttempt: {
    create: mockZkLoginAttemptCreate,
    deleteMany: mockZkLoginAttemptDeleteMany,
    findFirst: jest.fn(),
    update: jest.fn(),
  },
}));
jest.mock("../../models/eventLogs", () => ({
  EventLogs: { logEvent: jest.fn() },
}));
jest.mock("../../models/systemSettings", () => ({
  SystemSettings: { isMultiUserMode: jest.fn() },
}));
jest.mock("../../models/authIdentity", () => ({
  AuthIdentity: {
    bootstrapAuthUserFromShadow: jest.fn(),
    canLoginInCurrentEnvAsync: jest.fn(),
    ensureShadowUser: jest.fn(),
  },
}));
jest.mock("../../models/user", () => ({
  User: { _get: jest.fn(), filterFields: jest.fn((user) => user) },
}));
jest.mock("../../utils/middleware/validatedRequest", () => ({
  validatedRequest: jest.fn((_request, _response, next) => next()),
}));

const authPrisma = require("../../utils/authPrisma");
const { AuthIdentity } = require("../../models/authIdentity");
const { SystemSettings } = require("../../models/systemSettings");
const {
  authZkLoginEndpoints,
  _zkLoginTestUtils: {
    isTrustedDeviceSchemaError,
    normalizeDeviceId,
    normalizePasskeyReauthPurpose,
    opaqueIdentifiers,
    passkeyChallengeType,
    resetOpaqueServerSetupCacheForTest,
    sanitizeTrustedDevice,
    setOpaqueModuleOverrideForTest,
    zkUserIdentifier,
  },
} = require("../../endpoints/authZkLogin");

describe("ZK login endpoints", () => {
  const originalOpaqueServerSetup = process.env.OPAQUE_SERVER_SETUP;

  beforeEach(() => {
    jest.clearAllMocks();
    resetOpaqueServerSetupCacheForTest();
    process.env.OPAQUE_SERVER_SETUP = "test-opaque-server-setup";
    mockZkLoginAttemptDeleteMany.mockResolvedValue({ count: 0 });
    mockTrustedLoginDeviceUpdate.mockResolvedValue({});
    mockZkLoginAttemptCreate.mockResolvedValue({});
    mockOpaqueStartLogin.mockReturnValue({
      serverLoginState: "server-login-state",
      loginResponse: "login-response",
    });
    setOpaqueModuleOverrideForTest({
      ready: Promise.resolve(),
      server: {
        startLogin: mockOpaqueStartLogin,
      },
    });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    AuthIdentity.canLoginInCurrentEnvAsync.mockResolvedValue(true);
    mockReadSecretAsync.mockImplementation(async (value) => value);
    mockSaveSecretAsync.mockImplementation(async (value) => value);
  });

  afterAll(() => {
    setOpaqueModuleOverrideForTest(null);
    if (originalOpaqueServerSetup === undefined) {
      delete process.env.OPAQUE_SERVER_SETUP;
    } else {
      process.env.OPAQUE_SERVER_SETUP = originalOpaqueServerSetup;
    }
  });

  it("starts trusted-device login with the shared auth user id from the device record", async () => {
    const deviceId = "device_1234567890abcdef";
    const trustedDevice = {
      id: 3,
      userId: 91,
      deviceId,
      opaqueRegistrationRecord: "opaque-registration-record",
      lockedUntil: null,
      user: { id: 91, username: "shijie", suspended: 0 },
    };

    mockTrustedLoginDeviceFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(trustedDevice);
    mockPrismaUsersFindUnique.mockResolvedValue({ authUserId: 91 });

    const handler = routeHandlerFor("/auth/zk-login/login/start");
    const { request, response, json } = fakeJsonRequest({
      body: {
        userId: 7,
        deviceId,
        startLoginRequest: "opaque-start-login-request",
      },
    });

    await handler(request, response);

    expect(mockPrismaUsersFindUnique).toHaveBeenCalledWith({
      where: { id: 7 },
      select: { authUserId: true },
    });
    expect(mockOpaqueStartLogin).toHaveBeenCalledWith({
      serverSetup: "test-opaque-server-setup",
      userIdentifier: "athena:user:91:device:device_1234567890abcdef",
      registrationRecord: "opaque-registration-record",
      startLoginRequest: "opaque-start-login-request",
      identifiers: {
        client: "device_1234567890abcdef",
        server: "Athena",
      },
    });
    expect(authPrisma.zkLoginAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 91,
        deviceId,
        serverLoginState: "server-login-state",
      }),
    });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({
      success: true,
      loginAttemptId: expect.any(String),
      loginResponse: "login-response",
    });
  });

  it("loads the stored OPAQUE setup through remote-capable secret decryption", async () => {
    delete process.env.OPAQUE_SERVER_SETUP;
    const deviceId = "device_1234567890abcdef";
    const encryptedSetup = "enc:v2:key:secret-store:iv:tag:ciphertext";
    mockSystemSettingsFindFirst.mockResolvedValue({ value: encryptedSetup });
    mockReadSecretAsync.mockResolvedValue("remote-opaque-server-setup");
    mockTrustedLoginDeviceFindFirst.mockResolvedValue({
      id: 4,
      userId: 91,
      deviceId,
      opaqueRegistrationRecord: "opaque-registration-record",
      lockedUntil: null,
      user: { id: 91, username: "shijie", suspended: 0 },
    });

    const handler = routeHandlerFor("/auth/zk-login/login/start");
    const { request, response } = fakeJsonRequest({
      body: {
        userId: 91,
        deviceId,
        startLoginRequest: "opaque-start-login-request",
      },
    });

    await handler(request, response);

    expect(mockReadSecretAsync).toHaveBeenCalledWith(
      encryptedSetup,
      expect.objectContaining({
        purpose: "secret-store",
        domain: "authentication",
        resource: "opaque_server_setup",
        operation: "opaque-server-setup-read",
      })
    );
    expect(mockOpaqueStartLogin).toHaveBeenCalledWith(
      expect.objectContaining({ serverSetup: "remote-opaque-server-setup" })
    );
    expect(response.status).toHaveBeenCalledWith(200);
  });
});

describe("ZK login endpoint helpers", () => {
  it("accepts only base64url-style trusted device ids", () => {
    expect(normalizeDeviceId("abcDEF_123-4567890")).toBe("abcDEF_123-4567890");
    expect(normalizeDeviceId("short")).toBe(null);
    expect(normalizeDeviceId("unsafe/device/id")).toBe(null);
  });

  it("uses stable OPAQUE identifiers bound to shared authUserId", () => {
    expect(opaqueIdentifiers("device_1234567890abcdef")).toEqual({
      client: "device_1234567890abcdef",
      server: "Athena",
    });
    expect(zkUserIdentifier(91, "device_1234567890abcdef")).toBe(
      "athena:user:91:device:device_1234567890abcdef"
    );
  });

  it("purpose-binds passkey reauthentication challenges", () => {
    expect(normalizePasskeyReauthPurpose()).toBe("zk_enroll");
    expect(normalizePasskeyReauthPurpose("vault_access")).toBe("vault_access");
    expect(normalizePasskeyReauthPurpose("password_change")).toBe(
      "password_change"
    );
    expect(normalizePasskeyReauthPurpose("account_delete")).toBe(null);
    expect(passkeyChallengeType("zk_enroll")).toBe("zk_reauth");
    expect(passkeyChallengeType("vault_access")).toBe("zk_reauth:vault_access");
  });

  it("sanitizes trusted devices without registration records or verifier data", () => {
    const sanitized = sanitizeTrustedDevice({
      id: 1,
      userId: 2,
      deviceId: "device_1234567890abcdef",
      deviceName: "Mac",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      lastUsedAt: null,
      lastChallengeAt: null,
      lockedUntil: null,
      revokedAt: null,
      opaqueRegistrationRecord: "record",
      verifier: "verifier",
      publicCommitment: "commitment",
    });

    expect(sanitized).toEqual({
      id: 1,
      userId: 2,
      deviceId: "device_1234567890abcdef",
      deviceName: "Mac",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      lastUsedAt: null,
      lastChallengeAt: null,
      lockedUntil: null,
      revokedAt: null,
    });
    expect(sanitized.opaqueRegistrationRecord).toBeUndefined();
    expect(sanitized.verifier).toBeUndefined();
    expect(sanitized.publicCommitment).toBeUndefined();
  });

  it("recognizes missing trusted-device Prisma schema errors", () => {
    expect(
      isTrustedDeviceSchemaError({
        code: "P2021",
        message: "The table `main.TrustedLoginDevice` does not exist",
        meta: { table: "main.TrustedLoginDevice" },
      })
    ).toBe(true);
    expect(
      isTrustedDeviceSchemaError({
        code: "P2021",
        message: "The table `main.OtherTable` does not exist",
        meta: { table: "main.OtherTable" },
      })
    ).toBe(false);
  });
});

function routeHandlerFor(path) {
  const routes = [];
  const app = {
    post: jest.fn((routePath, ...handlers) =>
      routes.push({ method: "post", routePath, handlers })
    ),
    get: jest.fn((routePath, ...handlers) =>
      routes.push({ method: "get", routePath, handlers })
    ),
    delete: jest.fn((routePath, ...handlers) =>
      routes.push({ method: "delete", routePath, handlers })
    ),
  };
  authZkLoginEndpoints(app);
  const route = routes.find((candidate) => candidate.routePath === path);
  return route?.handlers?.at(-1);
}

function fakeJsonRequest({ body } = {}) {
  const json = jest.fn();
  const response = {
    locals: {},
    status: jest.fn(() => ({ json })),
  };
  const request = {
    body,
    get: jest.fn((header) =>
      header.toLowerCase() === "user-agent" ? "jest" : null
    ),
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
  };

  return { request, response, json };
}
