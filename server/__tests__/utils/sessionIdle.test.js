/* eslint-env jest */
const {
  IDLE_TIMEOUT_MS,
  USER_ACTION_REFRESH_THROTTLE_MS,
  USER_ACTION_REASONS,
  issueUserSessionToken,
  isAllowedUserActionReason,
  jwtIdleState,
  sessionClientIdFromToken,
  sessionTokenOptionsFromClientContext,
  tokenLastUserActionAt,
} = require("../../utils/sessionIdle");
const { decodeJWT } = require("../../utils/http");

describe("session idle policy helpers", () => {
  const originalJwtSecret = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = "test-session-secret";
  });

  afterAll(() => {
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  });

  it("accepts only explicit user-action reasons", () => {
    expect(isAllowedUserActionReason(USER_ACTION_REASONS.message_submit)).toBe(
      true
    );
    expect(isAllowedUserActionReason(USER_ACTION_REASONS.file_upload)).toBe(
      true
    );
    expect(isAllowedUserActionReason(USER_ACTION_REASONS.workspace_switch)).toBe(
      true
    );
    expect(isAllowedUserActionReason(USER_ACTION_REASONS.thread_switch)).toBe(
      true
    );
    expect(isAllowedUserActionReason(USER_ACTION_REASONS.knowledge_open)).toBe(
      true
    );
    expect(isAllowedUserActionReason(USER_ACTION_REASONS.page_navigation)).toBe(
      true
    );
    expect(isAllowedUserActionReason(USER_ACTION_REASONS.button_click)).toBe(
      true
    );
    expect(isAllowedUserActionReason(USER_ACTION_REASONS.security_action)).toBe(
      true
    );

    expect(isAllowedUserActionReason("input_local")).toBe(false);
    expect(isAllowedUserActionReason("check-token")).toBe(false);
    expect(isAllowedUserActionReason("sse_heartbeat")).toBe(false);
    expect(isAllowedUserActionReason("hub_refresh")).toBe(false);
  });

  it("uses lastUserActionAt to calculate 48 hour idle expiry", () => {
    const lastUserActionAt = Date.now() - IDLE_TIMEOUT_MS - 1_000;
    const state = jwtIdleState({ lastUserActionAt });

    expect(state.lastUserActionAt).toBe(lastUserActionAt);
    expect(state.idleExpired).toBe(true);
    expect(state.idleRemainingMs).toBe(0);
  });

  it("falls back to token iat only for older tokens without idle metadata", () => {
    const iat = Math.floor(Date.now() / 1_000) - 60;
    expect(tokenLastUserActionAt({ iat })).toBe(iat * 1_000);
    expect(USER_ACTION_REFRESH_THROTTLE_MS).toBe(60_000);
  });

  it("adds client-bound session claims only for non-legacy client contexts", () => {
    const options = sessionTokenOptionsFromClientContext({
      clientId: "client_abc",
      legacy: false,
    });
    const token = issueUserSessionToken(
      {
        id: 7,
        username: "user",
        role: "admin",
        allowedEnvs: ["development"],
      },
      options
    );
    const decoded = decodeJWT(token);

    expect(decoded.clientId).toBe("client_abc");
    expect(decoded.sessionId).toMatch(/^sess_/);
    expect(sessionClientIdFromToken(decoded)).toBe("client_abc");
    expect(sessionTokenOptionsFromClientContext({ clientId: "legacy" })).toEqual(
      {}
    );
  });

  it("preserves session id when refreshing a client-bound token", () => {
    const options = sessionTokenOptionsFromClientContext(
      { clientId: "client_abc", legacy: false },
      { sessionId: "sess_existing" }
    );
    expect(options).toEqual({
      clientId: "client_abc",
      sessionId: "sess_existing",
    });
  });
});
