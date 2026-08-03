const fs = require("fs");
const path = require("path");

const entrypoint = fs.readFileSync(
  path.resolve(__dirname, "../../../docker/docker-entrypoint.sh"),
  "utf8"
);

describe("Docker entrypoint runtime safety", () => {
  it("explicitly authorizes both production Prisma migrations", () => {
    expect(entrypoint).toContain(
      "node scripts/prisma-runtime.js --execute migrate deploy"
    );
    expect(entrypoint).toContain(
      "node scripts/auth-prisma-runtime.js --execute migrate deploy"
    );
    expect(entrypoint).not.toContain(
      "node scripts/prisma-runtime.js migrate deploy"
    );
    expect(entrypoint).not.toContain(
      "node scripts/auth-prisma-runtime.js migrate deploy"
    );
  });

  it.each([
    ["coordination-plane", "run_coordination_plane"],
    ["responses-runtime", "run_responses_runtime"],
    ["browser-egress", "run_browser_egress"],
  ])("dispatches the %s role without monolith fallback", (role, runner) => {
    expect(entrypoint).toContain(`${runner}() {`);
    expect(entrypoint).toContain(`  ${role})\n    ${runner}\n    ;;`);
  });
});
