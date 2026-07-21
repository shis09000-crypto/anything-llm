const fs = require("fs");
const os = require("os");
const path = require("path");

describe("updateENV bind-mounted env persistence", () => {
  let directory;
  let envPath;
  let originalDesktopEnvPath;
  let originalServerPort;

  beforeEach(() => {
    jest.resetModules();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "athena-env-mount-"));
    envPath = path.join(directory, ".env");
    fs.writeFileSync(envPath, "SERVER_PORT='3001'\n", { mode: 0o600 });
    originalDesktopEnvPath = process.env.DESKTOP_ENV_PATH;
    originalServerPort = process.env.SERVER_PORT;
    process.env.DESKTOP_ENV_PATH = envPath;
    process.env.SERVER_PORT = "3002";
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalDesktopEnvPath === undefined)
      delete process.env.DESKTOP_ENV_PATH;
    else process.env.DESKTOP_ENV_PATH = originalDesktopEnvPath;
    if (originalServerPort === undefined) delete process.env.SERVER_PORT;
    else process.env.SERVER_PORT = originalServerPort;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("falls back to an fsynced in-place write when rename hits EBUSY", () => {
    const rename = jest.spyOn(fs, "renameSync").mockImplementation(() => {
      const error = new Error("resource busy or locked");
      error.code = "EBUSY";
      throw error;
    });
    const fsync = jest.spyOn(fs, "fsyncSync");
    const { dumpENV } = require("../../../utils/helpers/updateENV");

    expect(dumpENV()).toBe(true);

    expect(rename).toHaveBeenCalledTimes(1);
    expect(fsync).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(envPath, "utf8")).toContain("SERVER_PORT='3002'");
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
    expect(
      fs.readdirSync(directory).filter((name) => name.endsWith(".tmp"))
    ).toEqual([]);
  });
});
