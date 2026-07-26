const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { storagePath } = require("../environment");
const keyPath = storagePath("comkey");

// What does this class do?
// This class generates a hashed version of some text (typically a JSON payload) using a persisted IPC RSA key
// that can then be appended as a header value to do integrity checking on a payload. Given the
// nature of this class, this protects the request
// integrity of requests sent to the collector as only the server can sign these requests.
// This keeps accidental misconfigurations of AnythingLLM that leaving port 8888 open from
// being abused or SSRF'd by users scraping malicious sites who have a loopback embedded in a <script>, for example.
// Since each request to the collector must be signed to be valid, unsigned requests directly to the collector
// will be dropped and must go through the /server endpoint directly.
class CommunicationKey {
  #privKeyName = "ipc-priv.pem";
  #pubKeyName = "ipc-pub.pem";
  #payloadKeyName = "ipc-payload.key";
  #storageLoc = keyPath;

  // Bootstrapping is intentionally idempotent. Hot reloads, health supervisors,
  // tests, and ordinary process restarts must never rotate persisted key material.
  constructor(ensureReady = false) {
    if (ensureReady) this.ensureReady();
  }

  log(text, ...args) {
    console.log(`\x1b[36m[CommunicationKey]\x1b[0m ${text}`, ...args);
  }

  #readPrivateKey() {
    return fs.readFileSync(path.resolve(this.#storageLoc, this.#privKeyName));
  }

  #keyLocations() {
    return {
      privateKeyPath: path.resolve(this.#storageLoc, this.#privKeyName),
      publicKeyPath: path.resolve(this.#storageLoc, this.#pubKeyName),
      payloadKeyPath: path.resolve(this.#storageLoc, this.#payloadKeyName),
    };
  }

  #validatePayloadKey(payloadKeyPath) {
    const encoded = fs.readFileSync(payloadKeyPath, "utf8").trim();
    const decoded = Buffer.from(encoded, "base64");
    if (
      !encoded ||
      decoded.length !== 32 ||
      decoded.toString("base64") !== encoded
    )
      throw new Error(
        "Collector payload key is invalid; refusing automatic replacement."
      );
    return decoded;
  }

  #generateInitialPayloadKey(payloadKeyPath) {
    const initializeLockPath = path.resolve(
      this.#storageLoc,
      ".ipc-payload-key-initialize.lock"
    );
    let initializeLock;
    let temporaryPath;
    fs.mkdirSync(this.#storageLoc, { recursive: true, mode: 0o700 });
    try {
      try {
        initializeLock = fs.openSync(initializeLockPath, "wx", 0o600);
      } catch (error) {
        if (error?.code === "EEXIST")
          throw new Error(
            "Collector payload key initialization is already in progress; refusing a concurrent write."
          );
        throw error;
      }

      // Preserve legacy source-payload readability without copying SIG_KEY or
      // SIG_SALT into Collector. New writes derive a purpose-specific AEAD key
      // from this 32-byte root with HKDF and never use it directly.
      const { EncryptionManager } = require("../EncryptionManager");
      const encoded = new EncryptionManager().xPayload;
      const nonce = `${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
      temporaryPath = `${payloadKeyPath}.${nonce}.tmp`;
      fs.writeFileSync(temporaryPath, encoded, { flag: "wx", mode: 0o600 });
      this.#validatePayloadKey(temporaryPath);
      if (fs.existsSync(payloadKeyPath))
        throw new Error(
          "Collector payload key destination changed during initialization; refusing replacement."
        );
      fs.renameSync(temporaryPath, payloadKeyPath);
    } finally {
      if (temporaryPath) fs.rmSync(temporaryPath, { force: true });
      if (initializeLock !== undefined) {
        fs.closeSync(initializeLock);
        fs.rmSync(initializeLockPath, { force: true });
      }
    }
    this.log(
      "Collector payload keyring initialized without rotating source credentials."
    );
  }

  #validatePair(privateKeyPath, publicKeyPath) {
    const challenge = crypto.randomBytes(32);
    const signature = crypto.sign(
      "RSA-SHA256",
      challenge,
      fs.readFileSync(privateKeyPath)
    );
    if (
      !crypto.verify(
        "RSA-SHA256",
        challenge,
        fs.readFileSync(publicKeyPath),
        signature
      )
    )
      throw new Error("Communication key pair validation failed.");
  }

  #generateInitialPair(privateKeyPath, publicKeyPath) {
    const initializeLockPath = path.resolve(
      this.#storageLoc,
      ".ipc-key-initialize.lock"
    );
    let initializeLock;
    let privateTempPath;
    let publicTempPath;
    fs.mkdirSync(this.#storageLoc, { recursive: true, mode: 0o700 });
    try {
      try {
        initializeLock = fs.openSync(initializeLockPath, "wx", 0o600);
      } catch (error) {
        if (error?.code === "EEXIST")
          throw new Error(
            "Communication key initialization is already in progress; refusing a concurrent write."
          );
        throw error;
      }

      const keyPair = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: {
          type: "pkcs1",
          format: "pem",
        },
        privateKeyEncoding: {
          type: "pkcs1",
          format: "pem",
        },
      });
      const nonce = `${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
      privateTempPath = `${privateKeyPath}.${nonce}.tmp`;
      publicTempPath = `${publicKeyPath}.${nonce}.tmp`;
      fs.writeFileSync(privateTempPath, keyPair.privateKey, {
        flag: "wx",
        mode: 0o600,
      });
      fs.writeFileSync(publicTempPath, keyPair.publicKey, {
        flag: "wx",
        mode: 0o644,
      });
      this.#validatePair(privateTempPath, publicTempPath);
      if (fs.existsSync(privateKeyPath) || fs.existsSync(publicKeyPath))
        throw new Error(
          "Communication key destination changed during initialization; refusing replacement."
        );
      fs.renameSync(privateTempPath, privateKeyPath);
      fs.renameSync(publicTempPath, publicKeyPath);
    } finally {
      if (privateTempPath) fs.rmSync(privateTempPath, { force: true });
      if (publicTempPath) fs.rmSync(publicTempPath, { force: true });
      if (initializeLock !== undefined) {
        fs.closeSync(initializeLock);
        fs.rmSync(initializeLockPath, { force: true });
      }
    }
    this.log(
      "RSA key pair initialized for signed payloads within AnythingLLM services."
    );
  }

  ensureReady() {
    fs.mkdirSync(this.#storageLoc, { recursive: true, mode: 0o700 });
    if ((fs.statSync(this.#storageLoc).mode & 0o777) !== 0o700)
      fs.chmodSync(this.#storageLoc, 0o700);
    const { privateKeyPath, publicKeyPath, payloadKeyPath } =
      this.#keyLocations();
    const privateKeyExists = fs.existsSync(privateKeyPath);
    const publicKeyExists = fs.existsSync(publicKeyPath);

    if (privateKeyExists !== publicKeyExists)
      throw new Error(
        "Communication key pair is incomplete; refusing automatic replacement."
      );

    let pairCreated = false;
    if (!privateKeyExists) {
      this.#generateInitialPair(privateKeyPath, publicKeyPath);
      pairCreated = true;
    } else {
      this.#validatePair(privateKeyPath, publicKeyPath);
      if ((fs.statSync(privateKeyPath).mode & 0o777) !== 0o600)
        fs.chmodSync(privateKeyPath, 0o600);
      if ((fs.statSync(publicKeyPath).mode & 0o777) !== 0o644)
        fs.chmodSync(publicKeyPath, 0o644);
      this.log("Validated existing RSA key pair without rotation.");
    }

    let payloadKeyCreated = false;
    if (!fs.existsSync(payloadKeyPath)) {
      this.#generateInitialPayloadKey(payloadKeyPath);
      payloadKeyCreated = true;
    } else {
      this.#validatePayloadKey(payloadKeyPath);
      if ((fs.statSync(payloadKeyPath).mode & 0o777) !== 0o600)
        fs.chmodSync(payloadKeyPath, 0o600);
    }

    return { created: pairCreated, payloadKeyCreated };
  }

  // The server owns the private signing key. Collector receives only the
  // public verification key and the separately scoped payload keyring root.
  sign(textData = "") {
    return crypto
      .sign("RSA-SHA256", Buffer.from(textData), this.#readPrivateKey())
      .toString("hex");
  }

  /**
   * Sign a complete Collector request envelope. Binding the HTTP method,
   * route, timestamp, nonce, and body digest prevents a valid payload from
   * being replayed against another endpoint or outside the accepted window.
   */
  signRequest({ method = "POST", requestPath = "/", body = "" } = {}) {
    const timestamp = Date.now().toString();
    const nonce = crypto.randomBytes(16).toString("base64url");
    const bodyBuffer = Buffer.isBuffer(body)
      ? body
      : Buffer.from(
          typeof body === "string" ? body : JSON.stringify(body ?? ""),
          "utf8"
        );
    const bodySha256 = crypto
      .createHash("sha256")
      .update(bodyBuffer)
      .digest("hex");
    const canonical = [
      "ATHENA-COLLECTOR-IPC-V2",
      String(method).toUpperCase(),
      requestPath,
      timestamp,
      nonce,
      bodySha256,
    ].join("\n");

    return {
      "X-Athena-IPC-Version": "2",
      "X-Athena-IPC-Timestamp": timestamp,
      "X-Athena-IPC-Nonce": nonce,
      "X-Athena-IPC-Body-SHA256": bodySha256,
      "X-Integrity": this.sign(canonical),
    };
  }
}

module.exports = { CommunicationKey };
