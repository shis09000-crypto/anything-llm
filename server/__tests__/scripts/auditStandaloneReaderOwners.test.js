const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  auditStandaloneReaderOwners,
  ownerState,
  parseArgs,
  rebindStandaloneReaderOwners,
} = require("../../scripts/audit-standalone-reader-owners");

function writeMetadata(root, id, metadata) {
  const dir = path.join(root, "__global_reader__", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`
  );
  return path.join(dir, "metadata.json");
}

describe("standalone reader owner audit script", () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "reader-owner-audit-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("classifies legacy ownerless, ownerless, and owned metadata", () => {
    expect(ownerState({ originalName: "old.pdf" })).toBe("legacy_ownerless");
    expect(ownerState({ ownerUserId: null })).toBe("ownerless");
    expect(ownerState({ ownerUserId: 10 })).toBe("owned");
  });

  it("audits standalone reader owner metadata without mutating files", async () => {
    writeMetadata(root, "doc-a", { originalName: "legacy.pdf" });
    writeMetadata(root, "doc-b", { originalName: "owned.pdf", ownerUserId: 10 });

    const result = await auditStandaloneReaderOwners({ root });

    expect(result.total).toBe(2);
    expect(result.ownerless).toBe(1);
    expect(result.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          readerDocumentId: "doc-a",
          ownerState: "legacy_ownerless",
        }),
        expect.objectContaining({
          readerDocumentId: "doc-b",
          ownerState: "owned",
          ownerUserId: 10,
        }),
      ])
    );
  });

  it("requires explicit fix mode for rebind CLI parsing", () => {
    expect(parseArgs(["--rebind-user-id", "10"]).dryRun).toBe(true);
    expect(() => parseArgs(["--fix"])).toThrow("--fix requires --rebind-user-id");
  });

  it("rebinds ownerless metadata only when dryRun is false", async () => {
    const metadataPath = writeMetadata(root, "doc-a", {
      originalName: "legacy.pdf",
    });

    await rebindStandaloneReaderOwners({
      root,
      rebindUserId: 10,
      rebindAuthUserId: "auth-10",
      dryRun: true,
    });
    expect(JSON.parse(fs.readFileSync(metadataPath, "utf8")).ownerUserId).toBe(
      undefined
    );

    const result = await rebindStandaloneReaderOwners({
      root,
      rebindUserId: 10,
      rebindAuthUserId: "auth-10",
      dryRun: false,
    });
    const next = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    expect(result.updated).toBe(1);
    expect(next.ownerUserId).toBe(10);
    expect(next.ownerAuthUserId).toBe("auth-10");
  });
});
