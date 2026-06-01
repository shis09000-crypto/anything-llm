/* eslint-env jest */
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  atomicWriteJsonFile,
  safeFileMove,
  safeReadJsonFile,
} = require("../../utils/safety");

describe("safety utilities", () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "safety-utils-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it("atomically writes and reads JSON", () => {
    const filePath = path.join(dir, "state.json");
    const write = atomicWriteJsonFile(filePath, { ok: true });
    expect(write.ok).toBe(true);

    const read = safeReadJsonFile(filePath, {});
    expect(read.ok).toBe(true);
    expect(read.value).toEqual({ ok: true });
  });

  it("quarantines corrupt JSON and returns fallback", () => {
    const filePath = path.join(dir, "state.json");
    fs.writeFileSync(filePath, "{bad json", "utf8");

    const read = safeReadJsonFile(filePath, { recovered: true });
    expect(read.ok).toBe(false);
    expect(read.value).toEqual({ recovered: true });
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.readdirSync(dir).some((name) => name.includes(".corrupt."))).toBe(
      true
    );
  });

  it("falls back to copy and unlink on cross-device moves", () => {
    const source = path.join(dir, "source.txt");
    const destination = path.join(dir, "nested", "destination.txt");
    fs.writeFileSync(source, "hello", "utf8");

    const renameSync = jest.spyOn(fs, "renameSync").mockImplementation(() => {
      const error = new Error("cross-device link not permitted");
      error.code = "EXDEV";
      throw error;
    });

    const result = safeFileMove(source, destination);
    expect(result.method).toBe("copy_unlink");
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(destination, "utf8")).toBe("hello");
    expect(renameSync).toHaveBeenCalled();
  });
});
