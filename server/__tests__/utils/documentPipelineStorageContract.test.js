/* eslint-env jest */

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  assertWritableDirectory,
} = require("../../utils/files/storageWriteContract");

describe("document pipeline storage contract", () => {
  const temporaryRoots = [];

  afterEach(() => {
    while (temporaryRoots.length)
      fs.rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  });

  test("creates and accepts a writable storage domain", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "athena-storage-"));
    temporaryRoots.push(root);
    const domain = path.join(root, "documents");

    expect(assertWritableDirectory(domain, "storage_unavailable")).toBe(true);
    expect(fs.statSync(domain).isDirectory()).toBe(true);
  });

  test("fails closed when a storage domain cannot be a directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "athena-storage-"));
    temporaryRoots.push(root);
    const domain = path.join(root, "documents");
    fs.writeFileSync(domain, "not a directory");

    expect(() =>
      assertWritableDirectory(domain, "storage_unavailable")
    ).toThrow("storage_unavailable");
  });
});
