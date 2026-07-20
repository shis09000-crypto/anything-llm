const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

describe("CommunicationKey boot lifecycle", () => {
  const originalEnvironment = { ...process.env };
  let storageBase;

  beforeEach(() => {
    jest.resetModules();
    storageBase = fs.mkdtempSync(path.join(os.tmpdir(), "athena-comkey-"));
    process.env.APP_ENV = "development";
    process.env.NODE_ENV = "development";
    process.env.ANYTHINGLLM_STORAGE_BASE_DIR = storageBase;
    delete process.env.ANYTHINGLLM_ENV_STORAGE_APPLIED;
    delete process.env.STORAGE_DIR;
  });

  afterEach(() => {
    process.env = { ...originalEnvironment };
    fs.rmSync(storageBase, { recursive: true, force: true });
    jest.resetModules();
  });

  function keyPaths() {
    const directory = path.join(storageBase, "development", "comkey");
    return {
      directory,
      privateKey: path.join(directory, "ipc-priv.pem"),
      publicKey: path.join(directory, "ipc-pub.pem"),
    };
  }

  test("initializes a missing pair once and preserves it across boot", () => {
    const { CommunicationKey } = require("../../utils/comKey");
    const paths = keyPaths();
    const first = new CommunicationKey(true);
    const privateBefore = fs.readFileSync(paths.privateKey);
    const publicBefore = fs.readFileSync(paths.publicKey);
    const privateMtimeBefore = fs.statSync(paths.privateKey).mtimeMs;
    const publicMtimeBefore = fs.statSync(paths.publicKey).mtimeMs;

    expect(first.sign("athena")).toBeTruthy();
    new CommunicationKey(true);

    expect(fs.readFileSync(paths.privateKey)).toEqual(privateBefore);
    expect(fs.readFileSync(paths.publicKey)).toEqual(publicBefore);
    expect(fs.statSync(paths.privateKey).mtimeMs).toBe(privateMtimeBefore);
    expect(fs.statSync(paths.publicKey).mtimeMs).toBe(publicMtimeBefore);
    expect(fs.statSync(paths.privateKey).mode & 0o777).toBe(0o600);
    expect(fs.statSync(paths.publicKey).mode & 0o777).toBe(0o644);
  });

  test("fails closed when only one side of the pair exists", () => {
    const paths = keyPaths();
    fs.mkdirSync(paths.directory, { recursive: true });
    const { publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "pkcs1", format: "pem" },
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
    });
    fs.writeFileSync(paths.publicKey, publicKey);
    const publicBefore = fs.readFileSync(paths.publicKey);
    const { CommunicationKey } = require("../../utils/comKey");

    expect(() => new CommunicationKey(true)).toThrow(
      "Communication key pair is incomplete"
    );
    expect(fs.existsSync(paths.privateKey)).toBe(false);
    expect(fs.readFileSync(paths.publicKey)).toEqual(publicBefore);
  });

  test("does not remove or bypass another initializer lock", () => {
    const paths = keyPaths();
    fs.mkdirSync(paths.directory, { recursive: true });
    const lockPath = path.join(paths.directory, ".ipc-key-initialize.lock");
    fs.writeFileSync(lockPath, "held", { mode: 0o600 });
    const { CommunicationKey } = require("../../utils/comKey");

    expect(() => new CommunicationKey(true)).toThrow(
      "Communication key initialization is already in progress"
    );
    expect(fs.readFileSync(lockPath, "utf8")).toBe("held");
    expect(fs.existsSync(paths.privateKey)).toBe(false);
    expect(fs.existsSync(paths.publicKey)).toBe(false);
  });

  test("fails closed for a mismatched pair without replacing either file", () => {
    const paths = keyPaths();
    fs.mkdirSync(paths.directory, { recursive: true });
    const first = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "pkcs1", format: "pem" },
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
    });
    const second = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "pkcs1", format: "pem" },
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
    });
    fs.writeFileSync(paths.privateKey, first.privateKey);
    fs.writeFileSync(paths.publicKey, second.publicKey);
    const privateBefore = fs.readFileSync(paths.privateKey);
    const publicBefore = fs.readFileSync(paths.publicKey);
    const { CommunicationKey } = require("../../utils/comKey");

    expect(() => new CommunicationKey(true)).toThrow(
      "Communication key pair validation failed"
    );
    expect(fs.readFileSync(paths.privateKey)).toEqual(privateBefore);
    expect(fs.readFileSync(paths.publicKey)).toEqual(publicBefore);
  });
});
