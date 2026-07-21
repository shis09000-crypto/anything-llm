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
});
