const fs = require("fs");
const path = require("path");

const serverRoot = path.resolve(__dirname, "../..");
const sourceRoots = ["models", "repositories", "utils"];
const ignoredDirectories = new Set([
  "__tests__",
  "generated",
  "node_modules",
  "storage",
]);

function javascriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...javascriptFiles(target));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(target);
  }
  return files;
}

describe("SQLite/PostgreSQL runtime dialect boundary", () => {
  const files = sourceRoots.flatMap((root) =>
    javascriptFiles(path.join(serverRoot, root))
  );

  it("keeps SQLite runtime DDL behind migration-owned PostgreSQL guards", () => {
    const unguarded = [];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      if (!/(AUTOINCREMENT|PRAGMA\s+table_info)/i.test(source)) continue;
      if (file.endsWith("schemaIntrospection.js")) continue;
      if (!source.includes("ensureMigrationOwnedTables")) {
        unguarded.push(path.relative(serverRoot, file));
      }
    }
    expect(unguarded).toEqual([]);
  });

  it("forbids SQLite connection-local IDs and date modifiers in runtime SQL", () => {
    const findings = [];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      if (/last_insert_rowid\s*\(/i.test(source))
        findings.push(`${path.relative(serverRoot, file)}:last_insert_rowid`);
      if (/datetime\(\s*['"]now['"]\s*,/i.test(source))
        findings.push(`${path.relative(serverRoot, file)}:datetime_modifier`);
    }
    expect(findings).toEqual([]);
  });
});
