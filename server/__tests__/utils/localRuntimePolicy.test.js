const {
  authorizeLocalRuntime,
  pathWithinRoots,
  riskFor,
} = require("../../utils/localRuntime/policy");

function lease(overrides = {}) {
  return {
    status: "active",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    capabilities: ["file.read", "file.write", "command.run", "desktop.act"],
    allowedRoots: ["/tmp/athena-runtime"],
    allowedApps: [],
    ...overrides,
  };
}

describe("Local Runtime policy", () => {
  test("contains paths without prefix confusion", () => {
    expect(pathWithinRoots("/tmp/athena-runtime/a.txt", ["/tmp/athena-runtime"])).toBe(true);
    expect(pathWithinRoots("/tmp/athena-runtime-escape/a.txt", ["/tmp/athena-runtime"])).toBe(false);
  });

  test("permanently rejects credential export and payments", () => {
    expect(riskFor("local_command_run", { command: "security dump-keychain" })).toMatchObject({ level: "L4", allowed: false });
    expect(riskFor("local_desktop_act", { action: "click", intent: "payment" })).toMatchObject({ level: "L4", allowed: false });
  });

  test("requires step-up for installation and elevation", () => {
    expect(riskFor("local_command_run", { command: "sudo installer -pkg x" })).toMatchObject({ level: "L3", approvalRequired: true });
  });

  test("checks lease capability and filesystem root", () => {
    expect(authorizeLocalRuntime({ toolName: "local_file_read", args: { path: "/tmp/athena-runtime/file.txt" }, lease: lease() })).toMatchObject({ allowed: true, risk: "L1" });
    expect(authorizeLocalRuntime({ toolName: "local_file_read", args: { path: "/etc/passwd" }, lease: lease() })).toMatchObject({ allowed: false, reasonCode: "local_runtime_path_outside_lease" });
  });

  test("expired lease always fails closed", () => {
    expect(authorizeLocalRuntime({ toolName: "local_file_read", args: {}, lease: lease({ expiresAt: new Date(0).toISOString() }) })).toMatchObject({ allowed: false, reasonCode: "local_runtime_lease_inactive" });
  });
});
