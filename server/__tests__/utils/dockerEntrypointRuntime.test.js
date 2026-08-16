const fs = require("fs");
const path = require("path");

describe("Docker entrypoint runtime safety", () => {
  it("explicitly authorizes both production Prisma migrations", () => {
    const entrypoint = fs.readFileSync(
      path.resolve(__dirname, "../../../docker/docker-entrypoint.sh"),
      "utf8"
    );

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

  it("migrates both authoritative SQLite databases in development", () => {
    const launcher = fs.readFileSync(
      path.resolve(__dirname, "../../../run-development"),
      "utf8"
    );

    expect(launcher).toContain('local db_path="$ENV_STORAGE_ROOT/anythingllm.db"');
    expect(launcher).toContain('local db_path="$STORAGE_BASE/shared/auth.db"');
    expect(launcher).toMatch(
      /ensure_env_database\s*\n\s*ensure_auth_database\s*\n\s*run_key_custody_preflight/
    );
  });
});
