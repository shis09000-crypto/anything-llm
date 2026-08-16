const fs = require("fs");
const path = require("path");

const configPath = path.resolve(
  __dirname,
  "../../../docker/nginx-web.conf.template"
);
const config = fs.readFileSync(configPath, "utf8");

describe("edge Web SPA routing", () => {
  test("never exposes the internal listener in redirects", () => {
    expect(config).toMatch(/\babsolute_redirect\s+off;/);
    expect(config).toMatch(/\bport_in_redirect\s+off;/);
  });

  test.each(["/login", "/login/"])(
    "serves %s from the SPA entry instead of the artwork directory",
    (route) => {
      const escaped = route.replace("/", "\\/");
      const location = new RegExp(
        `location\\s+=\\s+${escaped}\\s*\\{[\\s\\S]*?try_files\\s+\\/index\\.html\\s+=404;[\\s\\S]*?\\}`
      );
      expect(config).toMatch(location);
    }
  );
});
