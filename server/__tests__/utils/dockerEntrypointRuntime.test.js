const fs = require("fs");
const path = require("path");

const entrypoint = fs.readFileSync(
  path.resolve(__dirname, "../../../docker/docker-entrypoint.sh"),
  "utf8"
);
const runtimeReleaseDockerfile = fs.readFileSync(
  path.resolve(
    __dirname,
    "../../../.athena-release-staging/runtime-link-recovery-v2.5.51/Dockerfile"
  ),
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

  it("generates and verifies the PostgreSQL Responses delegates", () => {
    expect(runtimeReleaseDockerfile).toContain(
      "server/prisma/postgresql/schema.prisma"
    );
    expect(runtimeReleaseDockerfile).toContain(
      "20260803090000_add_responses_runtime"
    );
    expect(runtimeReleaseDockerfile).toContain(
      "npx prisma generate --schema=prisma/postgresql/schema.prisma"
    );
    expect(runtimeReleaseDockerfile).toContain(
      "responses_prisma_delegate_missing"
    );
  });
});
