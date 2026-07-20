const fs = require("fs");
const path = require("path");

const collectorRoot = path.resolve(__dirname, "../..");

function sourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (
      ["node_modules", "__tests__", "storage", "hotdir"].includes(entry.name)
    )
      continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(target));
    else if (entry.name.endsWith(".js")) files.push(target);
  }
  return files;
}

describe("collector network egress boundary", () => {
  it("keeps direct fetch and DNS rebinding checks inside networkGuard", () => {
    const violations = [];
    for (const file of sourceFiles(collectorRoot)) {
      const relative = path
        .relative(collectorRoot, file)
        .replaceAll(path.sep, "/");
      if (relative === "utils/networkGuard/index.js") continue;
      const source = fs.readFileSync(file, "utf8");
      if (/\bfetch\s*\(/.test(source)) violations.push(relative);
    }
    expect(violations).toEqual([]);
  });

  it("does not mutate process-wide TLS verification", () => {
    const violations = sourceFiles(collectorRoot).filter((file) =>
      /NODE_TLS_REJECT_UNAUTHORIZED\s*=/.test(fs.readFileSync(file, "utf8"))
    );
    expect(violations).toEqual([]);
  });
});
