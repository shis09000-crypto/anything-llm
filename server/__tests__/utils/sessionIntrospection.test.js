/* eslint-env jest */

process.env.JWT_SECRET ||= "session-introspection-test-secret";

const { makeJWT } = require("../../utils/http");
const {
  introspectSessionToken,
} = require("../../utils/authz/sessionIntrospection");

function fixture({ clientRevoked = false } = {}) {
  const session = {
    sessionId: "sess-1",
    authUserId: 17,
    clientId: "browser-1",
    authMode: "passkey",
    tokenVersion: 1,
  };
  const data = {
    adminSystem: {
      isMultiUserMode: jest.fn().mockResolvedValue(true),
      authSession: {
        validate: jest.fn().mockResolvedValue({ valid: true, session }),
      },
    },
    authIdentity: {
      shadowUser: {
        _get: jest.fn().mockResolvedValue({
          id: 10,
          authUserId: 17,
        }),
      },
      model: {
        findById: jest.fn().mockResolvedValue({ id: 17 }),
        canLoginInCurrentEnvAsync: jest.fn().mockResolvedValue(true),
      },
    },
  };
  const findClient = jest.fn().mockResolvedValue({
    clientId: "browser-1",
    revokedAt: clientRevoked ? new Date() : null,
  });
  return { data, findClient, session };
}

describe("authoritative session introspection", () => {
  test("returns only a minimal principal after account and client validation", async () => {
    const { data, findClient } = fixture();
    const token = makeJWT({
      id: 10,
      authUserId: 17,
      sid: "sess-1",
      clientId: "browser-1",
      tokenVersion: 1,
      role: "admin",
      lastUserActionAt: Date.now(),
    });

    await expect(
      introspectSessionToken(token, { data, findClient })
    ).resolves.toEqual({
      success: true,
      active: true,
      principal: {
        subjectType: "user",
        userId: 10,
        authUserId: 17,
        sessionId: "sess-1",
        clientId: "browser-1",
        authMode: "passkey",
        role: "admin",
        tokenVersion: 1,
      },
    });
    expect(data.adminSystem.authSession.validate).toHaveBeenCalledWith(
      "sess-1",
      {
        authoritative: true,
        subjectType: "user",
        tokenVersion: 1,
      }
    );
    expect(findClient).toHaveBeenCalledWith({
      userId: 10,
      clientId: "browser-1",
      includeRevoked: true,
    });
  });

  test("fails closed when the bound client was revoked", async () => {
    const { data, findClient } = fixture({ clientRevoked: true });
    const token = makeJWT({
      id: 10,
      authUserId: 17,
      sid: "sess-1",
      clientId: "browser-1",
      tokenVersion: 1,
      lastUserActionAt: Date.now(),
    });

    await expect(
      introspectSessionToken(token, { data, findClient })
    ).resolves.toEqual({
      success: true,
      active: false,
      reasonCode: "client_revoked",
    });
  });

  test("rejects tokens without a persisted session", async () => {
    const { data, findClient } = fixture();
    const token = makeJWT({ id: 10, lastUserActionAt: Date.now() });
    await expect(
      introspectSessionToken(token, { data, findClient })
    ).resolves.toEqual({
      success: true,
      active: false,
      reasonCode: "session_missing",
    });
    expect(data.adminSystem.authSession.validate).not.toHaveBeenCalled();
  });
});
