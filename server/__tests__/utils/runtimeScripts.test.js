const fs = require("fs");
const path = require("path");

const repositoryRoot = path.resolve(__dirname, "../../..");

describe("local runtime scripts", () => {
  test.each(["scripts/runtime-supervisor.sh", "stop-all"])(
    "%s allows the API drain deadline before force termination",
    (relativePath) => {
      const source = fs.readFileSync(
        path.join(repositoryRoot, relativePath),
        "utf8"
      );

      expect(source).toContain('STOP_GRACE_SECONDS="${STOP_GRACE_SECONDS:-35}"');
      expect(source).toMatch(/STOP_GRACE_SECONDS < 30/);
      expect(source).toMatch(/kill -9 "\$pid"/);
    }
  );
});
