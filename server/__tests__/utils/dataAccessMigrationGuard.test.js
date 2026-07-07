const path = require("path");
const fs = require("fs");
const os = require("os");

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR || path.resolve(__dirname, "../../storage");

const {
  assertMigrationCompliance,
  compareFindingsToBaseline,
  dataAccessMode,
  recordBypassAccess,
  resetForTests,
  runtimeBypassSnapshot,
  scanBypassAccess,
  scanScriptAccess,
  writeBypassBaseline,
} = require("../../utils/dataAccess/dataAccessMigrationGuard");

describe("dataAccessMigrationGuard", () => {
  beforeEach(() => {
    delete process.env.DATA_ACCESS_MODE;
    delete process.env.DATA_ACCESS_BASELINE_PATH;
    delete process.env.DATA_ACCESS_ENFORCE_FULL;
    resetForTests();
  });

  test("defaults to observe mode for non-disruptive migration", () => {
    expect(dataAccessMode()).toBe("observe");
  });

  test("records runtime bypass events without throwing", () => {
    recordBypassAccess({
      domain: "workspace",
      caller: "legacy-endpoint",
      accessType: "read",
      reason: "compat",
    });

    expect(runtimeBypassSnapshot()).toMatchObject({
      total: 1,
      byDomain: { workspace: 1 },
      recent: [
        expect.objectContaining({
          domain: "workspace",
          caller: "legacy-endpoint",
        }),
      ],
    });
  });

  test("static audit respects low-level allowlist", () => {
    const audit = scanBypassAccess({
      roots: ["utils/prisma"],
      includeAllowed: true,
    });

    expect(audit.mode).toBe("observe");
    expect(audit.findingsCount).toBeGreaterThan(0);
    expect(audit.findings.some((finding) => finding.allowed)).toBe(true);
    expect(audit.blocked).toBe(0);
  });

  test("compares current findings against a counted baseline", () => {
    const finding = {
      type: "direct-model-import",
      file: "endpoints/example.js",
      domain: "workspace",
      match: 'require("../models/workspace")',
      detail: "workspace",
    };
    const comparison = compareFindingsToBaseline(
      [finding, finding, { ...finding, detail: "workspaceThread" }],
      {
        blocked: 1,
        findings: [{ ...finding, key: Object.values(finding).join("|"), count: 1 }],
      }
    );

    expect(comparison.hasNewBypass).toBe(true);
    expect(comparison.additions.length).toBeGreaterThan(0);
  });

  test("enforce mode allows the checked-in baseline but blocks new signatures", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "data-access-"));
    const baselinePath = path.join(tmpDir, "baseline.json");
    process.env.DATA_ACCESS_BASELINE_PATH = baselinePath;
    process.env.DATA_ACCESS_MODE = "enforce";

    const audit = scanBypassAccess({ limit: Infinity });
    writeBypassBaseline({ baselinePath, audit });
    expect(() => assertMigrationCompliance({ limit: Infinity })).not.toThrow();

    const serverRoot = path.resolve(__dirname, "../..");
    const fixtureRoot = `tmp-data-access-${Date.now()}`;
    const fixtureDir = path.join(serverRoot, fixtureRoot);
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(
      path.join(fixtureDir, "legacyEndpoint.js"),
      'const { Workspace } = require("../models/workspace");\nmodule.exports = Workspace;\n'
    );
    try {
      expect(() =>
        assertMigrationCompliance({ roots: [fixtureRoot], limit: Infinity })
      ).toThrow(/new direct data access signatures/);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("full enforce mode fails while historical bypasses remain", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "data-access-"));
    const baselinePath = path.join(tmpDir, "baseline.json");
    process.env.DATA_ACCESS_BASELINE_PATH = baselinePath;
    process.env.DATA_ACCESS_MODE = "enforce";
    process.env.DATA_ACCESS_ENFORCE_FULL = "true";

    const serverRoot = path.resolve(__dirname, "../..");
    const fixtureRoot = `tmp-data-access-full-${Date.now()}`;
    const fixtureDir = path.join(serverRoot, fixtureRoot);
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(
      path.join(fixtureDir, "legacyEndpoint.js"),
      'const prisma = require("../utils/prisma");\nmodule.exports = () => prisma.users.findMany();\n'
    );
    try {
      const audit = scanBypassAccess({
        roots: [fixtureRoot],
        limit: Infinity,
      });
      writeBypassBaseline({ baselinePath, audit });
      expect(() =>
        assertMigrationCompliance({ roots: [fixtureRoot], limit: Infinity })
      ).toThrow(/direct data access sites/);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("script access report classifies current maintenance scripts", () => {
    const report = scanScriptAccess({ limit: Infinity });

    expect(report.findingsCount).toBeGreaterThan(0);
    expect(report.unclassified).toBe(0);
    expect(report.byCategory.migration).toBeGreaterThan(0);
    expect(report.byRisk["secret-write"]).toBeGreaterThan(0);
  });
});
