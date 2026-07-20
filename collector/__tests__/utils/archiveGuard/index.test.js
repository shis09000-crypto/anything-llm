const { _private } = require("../../../utils/archiveGuard");

describe("collector archive guard", () => {
  test.each([
    "../secret.txt",
    "nested/../../secret.txt",
    "/etc/passwd",
    "C:/Windows/System32/config",
    "nested\\..\\secret.txt",
  ])("rejects unsafe archive entry %s", (name) => {
    expect(_private.unsafeEntryName(name)).toBe(true);
  });

  test.each([
    "word/document.xml",
    "xl/worksheets/sheet1.xml",
    "nested/file.txt",
  ])("accepts confined archive entry %s", (name) => {
    expect(_private.unsafeEntryName(name)).toBe(false);
  });
});
