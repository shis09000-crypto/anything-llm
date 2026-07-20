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
    };
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
    const { privateKeyPath, publicKeyPath } = this.#keyLocations();
    const privateKeyExists = fs.existsSync(privateKeyPath);
    const publicKeyExists = fs.existsSync(publicKeyPath);

    if (privateKeyExists !== publicKeyExists)
      throw new Error(
        "Communication key pair is incomplete; refusing automatic replacement."
      );

    if (!privateKeyExists) {
      this.#generateInitialPair(privateKeyPath, publicKeyPath);
      return { created: true };
    }

    this.#validatePair(privateKeyPath, publicKeyPath);
    if ((fs.statSync(privateKeyPath).mode & 0o777) !== 0o600)
      fs.chmodSync(privateKeyPath, 0o600);
    if ((fs.statSync(publicKeyPath).mode & 0o777) !== 0o644)
      fs.chmodSync(publicKeyPath, 0o644);
    this.log("Validated existing RSA key pair without rotation.");
    return { created: false };
  }

  // This instance of ComKey on server is intended for generation of Priv/Pub key for signing and decoding.
  // this resource is shared with /collector/ via a class of the same name in /utils which does decoding/verification only
  // while this server class only does signing with the private key.
  sign(textData = "") {
    return crypto
      .sign("RSA-SHA256", Buffer.from(textData), this.#readPrivateKey())
      .toString("hex");
  }

  // Use the IPC private key to encrypt arbitrary data that is text
  // returns the encrypted content as a base64 string.
  encrypt(textData = "") {
    return crypto
      .privateEncrypt(this.#readPrivateKey(), Buffer.from(textData, "utf-8"))
      .toString("base64");
  }
}

module.exports = { CommunicationKey };
