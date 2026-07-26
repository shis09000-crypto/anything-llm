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
    process.env.SIG_KEY = "athena-test-collector-signing-key-material";
    process.env.SIG_SALT = "athena-test-collector-signing-salt-material";
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
      payloadKey: path.join(directory, "ipc-payload.key"),
    };
  }

  test("initializes a missing pair once and preserves it across boot", () => {
    const { CommunicationKey } = require("../../utils/comKey");
    const paths = keyPaths();
    const first = new CommunicationKey(true);
    const privateBefore = fs.readFileSync(paths.privateKey);
    const publicBefore = fs.readFileSync(paths.publicKey);
    const payloadBefore = fs.readFileSync(paths.payloadKey);
    const privateMtimeBefore = fs.statSync(paths.privateKey).mtimeMs;
    const publicMtimeBefore = fs.statSync(paths.publicKey).mtimeMs;
    const payloadMtimeBefore = fs.statSync(paths.payloadKey).mtimeMs;

    expect(first.sign("athena")).toBeTruthy();
    new CommunicationKey(true);

    expect(fs.readFileSync(paths.privateKey)).toEqual(privateBefore);
    expect(fs.readFileSync(paths.publicKey)).toEqual(publicBefore);
    expect(fs.readFileSync(paths.payloadKey)).toEqual(payloadBefore);
    expect(fs.statSync(paths.privateKey).mtimeMs).toBe(privateMtimeBefore);
    expect(fs.statSync(paths.publicKey).mtimeMs).toBe(publicMtimeBefore);
    expect(fs.statSync(paths.payloadKey).mtimeMs).toBe(payloadMtimeBefore);
    expect(fs.statSync(paths.privateKey).mode & 0o777).toBe(0o600);
    expect(fs.statSync(paths.publicKey).mode & 0o777).toBe(0o644);
    expect(fs.statSync(paths.payloadKey).mode & 0o777).toBe(0o600);
    expect(fs.statSync(paths.directory).mode & 0o777).toBe(0o700);
    expect(
      Buffer.from(fs.readFileSync(paths.payloadKey, "utf8"), "base64")
    ).toHaveLength(32);
  });

  test("binds request signatures to route, method, body, time, and nonce", () => {
    const {
      CommunicationKey: ServerCommunicationKey,
    } = require("../../utils/comKey");
    const {
      CommunicationKey: CollectorCommunicationKey,
    } = require("../../../collector/utils/comKey");
    const serverKey = new ServerCommunicationKey(true);
    const collectorKey = new CollectorCommunicationKey();
    const body = JSON.stringify({ value: "athena" });
    const headers = serverKey.signRequest({
      method: "POST",
      requestPath: "/process-link",
      body,
    });
    const request = {
      signature: headers["X-Integrity"],
      method: "POST",
      requestPath: "/process-link",
      timestamp: headers["X-Athena-IPC-Timestamp"],
      nonce: headers["X-Athena-IPC-Nonce"],
      bodySha256: headers["X-Athena-IPC-Body-SHA256"],
      body,
    };

    expect(collectorKey.verifyRequest(request)).toMatchObject({ ok: true });
    expect(
      collectorKey.verifyRequest({ ...request, requestPath: "/process" })
    ).toMatchObject({ ok: false, reason: "invalid_signature" });
    expect(
      collectorKey.verifyRequest({ ...request, body: '{"value":"tampered"}' })
    ).toMatchObject({ ok: false, reason: "body_digest_mismatch" });
    expect(
      collectorKey.verifyRequest({
        ...request,
        now: Number(request.timestamp) + 5 * 60_000 + 1,
      })
    ).toMatchObject({ ok: false, reason: "expired_timestamp" });
  });

  test("rejects replayed signed requests before Collector work begins", () => {
    const { CommunicationKey } = require("../../utils/comKey");
    const key = new CommunicationKey(true);
    const body = JSON.stringify({ options: {}, value: "athena" });
    const headers = key.signRequest({
      method: "POST",
      requestPath: "/process-link",
      body,
    });
    const request = {
      method: "POST",
      originalUrl: "/process-link",
      body: JSON.parse(body),
      header: (name) => headers[name],
    };
    const response = {
      statusCode: null,
      payload: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.payload = payload;
        return this;
      },
    };
    const next = jest.fn();
    const {
      verifyPayloadIntegrity,
    } = require("../../../collector/middleware/verifyIntegrity");

    verifyPayloadIntegrity(request, response, next);
    expect(next).toHaveBeenCalledTimes(1);

    verifyPayloadIntegrity(request, response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(400);
    expect(response.payload).toMatchObject({
      error: "collector_integrity_check_failed",
      reason: "replayed_nonce",
    });
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
