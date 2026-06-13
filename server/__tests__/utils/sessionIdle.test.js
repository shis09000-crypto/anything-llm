/* eslint-env jest */
const {
  IDLE_TIMEOUT_MS,
  USER_ACTION_REFRESH_THROTTLE_MS,
  USER_ACTION_REASONS,
  isAllowedUserActionReason,
  jwtIdleState,
  tokenLastUserActionAt,
} = require("../../utils/sessionIdle");

describe("session idle policy helpers", () => {
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
});
