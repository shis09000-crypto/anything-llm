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

    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    baseline.findings = [];
    baseline.blocked = 0;
    fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));

    expect(() => assertMigrationCompliance({ limit: Infinity })).toThrow(
      /new direct data access signatures/
    );
  });

  test("full enforce mode fails while historical bypasses remain", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "data-access-"));
    const baselinePath = path.join(tmpDir, "baseline.json");
    process.env.DATA_ACCESS_BASELINE_PATH = baselinePath;
    process.env.DATA_ACCESS_MODE = "enforce";
    process.env.DATA_ACCESS_ENFORCE_FULL = "true";

    writeBypassBaseline({ baselinePath });
    expect(() => assertMigrationCompliance({ limit: Infinity })).toThrow(
      /direct data access sites/
    );
  });
});
