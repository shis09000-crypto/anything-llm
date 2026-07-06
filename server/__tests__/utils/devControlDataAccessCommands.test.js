const path = require("path");

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR || path.resolve(__dirname, "../../storage");

const { CommandRegistry } = require("../../utils/devControl/commandRegistry");
const {
  DATA_ACCESS_COMMANDS,
  registerDataAccessCommands,
} = require("../../utils/devControl/dataAccessCommands");

describe("developer data access commands", () => {
  function context() {
    return {
      context: {
        commandId: "cmd_test",
        requestId: "req_test",
        sessionId: "session_test",
        clientId: "client_test",
        userId: 1,
      },
      params: {},
      scope: {},
    };
  }

  test("registers the expected command allowlist", () => {
    const registry = new CommandRegistry();
    registerDataAccessCommands(registry);

    for (const command of DATA_ACCESS_COMMANDS) {
      expect(registry.has(command)).toBe(true);
    }
  });

  test("snapshot command returns mode and bypass audit", async () => {
    const registry = new CommandRegistry();
    registerDataAccessCommands(registry);

    const result = await registry.execute("dataAccess.snapshot", {
      ...context(),
      params: { limit: 5 },
    });

    expect(result).toMatchObject({
      mode: "observe",
      bypassAudit: expect.objectContaining({
        mode: "observe",
        findingsCount: expect.any(Number),
      }),
    });
  });

  test("domain status rejects unknown domains", async () => {
    const registry = new CommandRegistry();
    registerDataAccessCommands(registry);

    await expect(
      registry.execute("dataAccess.domain.status", {
        ...context(),
        params: { domain: "missing" },
      })
    ).rejects.toMatchObject({
      code: "data_access_domain_not_registered",
    });
  });
});
