/* global jest, describe, beforeEach, afterEach, it, expect */
const fs = require("fs");
const os = require("os");
const path = require("path");

const originalStorageDir = process.env.STORAGE_DIR;

describe("retained DOCX sources", () => {
  let storageDir;
  let sources;

  beforeEach(() => {
    jest.resetModules();
    storageDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "anything-docx-source-")
    );
    process.env.STORAGE_DIR = storageDir;
    sources = require("../../utils/documentSources");
  });

  afterEach(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
    if (originalStorageDir === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = originalStorageDir;
  });

  it("stores DOCX sources as opaque mode-0600 files and removes them", () => {
    const input = path.join(storageDir, "report.docx");
    fs.writeFileSync(input, Buffer.from("PK retained source"));

    const token = sources.saveDocxSource(input);
    const storedPath = sources.sourcePathForToken(token);
    expect(token).toMatch(/^[0-9a-f-]{36}\.docx$/);
    expect(fs.statSync(storedPath).mode & 0o777).toBe(0o600);
    expect(sources.readDocxSource(token)).toEqual(
      Buffer.from("PK retained source")
    );
    expect(
      sources.sourceTokenFromMetadata(JSON.stringify({ docxSource: { token } }))
    ).toBe(token);
    expect(
      sources.cleanupDocxSources([
        { metadata: JSON.stringify({ docxSource: { token } }) },
      ])
    ).toBe(1);
    expect(fs.existsSync(storedPath)).toBe(false);
  });

  it("rejects non-DOCX files and invalid source tokens", () => {
    const input = path.join(storageDir, "notes.txt");
    fs.writeFileSync(input, "notes");
    expect(sources.saveDocxSource(input)).toBeNull();
    expect(sources.readDocxSource("../../report.docx")).toBeNull();
    expect(sources.deleteDocxSource("https://example.com/a.docx")).toBe(false);
  });
});
