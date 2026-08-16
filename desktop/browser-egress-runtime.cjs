const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const SEALED_VERSION = "athena-browser-egress-sealed:v1";
const CLIENT_VERSION = "athena-browser-egress-client:v1";
const CORE_MANIFEST_VERSION = "athena-browser-egress-core:v1";

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function requireString(value, code, max = 1024) {
  const text = String(value || "").trim();
  if (!text || text.length > max) throw new Error(code);
  return text;
}

function safeJson(value, code) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(code);
  }
}

function randomPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function waitForPort(port, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline)
          reject(new Error("browser_egress_local_proxy_start_timeout"));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

function readSocket(socket, minimum, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let chunks = Buffer.alloc(0);
    const timer = setTimeout(
      () => done(new Error("browser_egress_probe_timeout")),
      timeoutMs
    );
    const done = (error, value) => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      if (error) reject(error);
      else resolve(value);
    };
    const onError = (error) => done(error);
    const onData = (chunk) => {
      chunks = Buffer.concat([chunks, chunk]);
      if (chunks.length >= minimum) done(null, chunks);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

async function probeSocks(local, target = "www.cloudflare.com") {
  const startedAt = Date.now();
  const socket = net.createConnection({ host: local.host, port: local.port });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  try {
    socket.write(Buffer.from([0x05, 0x01, 0x02]));
    const method = await readSocket(socket, 2);
    if (method[0] !== 0x05 || method[1] !== 0x02)
      throw new Error("browser_egress_proxy_auth_method_rejected");
    const username = Buffer.from(local.username);
    const password = Buffer.from(local.password);
    socket.write(
      Buffer.concat([
        Buffer.from([0x01, username.length]),
        username,
        Buffer.from([password.length]),
        password,
      ])
    );
    const authenticated = await readSocket(socket, 2);
    if (authenticated[1] !== 0x00)
      throw new Error("browser_egress_proxy_auth_failed");
    const host = Buffer.from(target);
    socket.write(
      Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
        host,
        Buffer.from([0x01, 0xbb]),
      ])
    );
    const connected = await readSocket(socket, 5, 8_000);
    if (connected[1] !== 0x00)
      throw new Error("browser_egress_remote_probe_failed");
    return { connected: true, latencyMs: Date.now() - startedAt };
  } finally {
    socket.destroy();
  }
}

function privateAddressLiteral(host) {
  const value = String(host || "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (["localhost", "localhost.localdomain"].includes(value)) return true;
  if (
    value === "::1" ||
    value === "::" ||
    value.startsWith("fe80:") ||
    value.startsWith("fc") ||
    value.startsWith("fd")
  )
    return true;
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part)))
    return false;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

async function connectThroughAuthenticatedSocks(local, host, port) {
  if (privateAddressLiteral(host))
    throw new Error("browser_egress_private_destination_forbidden");
  const socket = net.createConnection({ host: local.host, port: local.port });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  try {
    socket.write(Buffer.from([0x05, 0x01, 0x02]));
    const method = await readSocket(socket, 2);
    if (method[0] !== 0x05 || method[1] !== 0x02)
      throw new Error("browser_egress_proxy_auth_method_rejected");
    const username = Buffer.from(local.username);
    const password = Buffer.from(local.password);
    socket.write(
      Buffer.concat([
        Buffer.from([0x01, username.length]),
        username,
        Buffer.from([password.length]),
        password,
      ])
    );
    const authenticated = await readSocket(socket, 2);
    if (authenticated[1] !== 0x00)
      throw new Error("browser_egress_proxy_auth_failed");
    const encodedHost = Buffer.from(host);
    if (!encodedHost.length || encodedHost.length > 255)
      throw new Error("browser_egress_destination_invalid");
    socket.write(
      Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, encodedHost.length]),
        encodedHost,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
      ])
    );
    const connected = await readSocket(socket, 5, 8_000);
    if (connected[1] !== 0x00)
      throw new Error("browser_egress_remote_connect_failed");
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function executableName() {
  return process.platform === "win32" ? "sing-box.exe" : "sing-box";
}

function verifyCore(coreDir) {
  const manifestFile = path.join(coreDir, "manifest.json");
  if (!fs.existsSync(manifestFile))
    throw new Error("browser_egress_core_manifest_missing");
  const manifest = safeJson(
    fs.readFileSync(manifestFile, "utf8"),
    "browser_egress_core_manifest_invalid"
  );
  if (manifest.schemaVersion !== CORE_MANIFEST_VERSION)
    throw new Error("browser_egress_core_manifest_version_invalid");
  if (manifest.platform !== process.platform || manifest.arch !== process.arch)
    throw new Error("browser_egress_core_platform_mismatch");
  const binary = path.resolve(
    coreDir,
    requireString(manifest.file, "browser_egress_core_file_missing", 128)
  );
  if (!binary.startsWith(`${path.resolve(coreDir)}${path.sep}`))
    throw new Error("browser_egress_core_path_invalid");
  if (!fs.existsSync(binary)) throw new Error("browser_egress_core_missing");
  if (sha256File(binary) !== String(manifest.sha256 || "").toLowerCase())
    throw new Error("browser_egress_core_sha256_mismatch");
  const statement = Buffer.from(
    JSON.stringify({
      schemaVersion: manifest.schemaVersion,
      version: manifest.version,
      platform: manifest.platform,
      arch: manifest.arch,
      file: manifest.file,
      sha256: manifest.sha256,
    })
  );
  const publicKey = crypto.createPublicKey(
    requireString(
      manifest.mldsa65PublicKey,
      "browser_egress_core_signature_missing",
      16_384
    )
  );
  if (publicKey.asymmetricKeyType !== "ml-dsa-65")
    throw new Error("browser_egress_core_signature_key_invalid");
  const trust = safeJson(
    fs.readFileSync(path.join(coreDir, "..", "trust.json"), "utf8"),
    "browser_egress_core_trust_invalid"
  );
  const publicKeySha256 = crypto
    .createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  if (
    trust.schemaVersion !== "athena-browser-egress-core-trust:v1" ||
    trust.publicKeySha256 !== publicKeySha256
  )
    throw new Error("browser_egress_core_trust_mismatch");
  const verified = crypto.verify(
    null,
    statement,
    publicKey,
    Buffer.from(
      requireString(
        manifest.mldsa65Signature,
        "browser_egress_core_signature_missing",
        16_384
      ),
      "base64"
    )
  );
  if (!verified) throw new Error("browser_egress_core_signature_invalid");
  if (process.platform !== "win32") fs.chmodSync(binary, 0o500);
  return { binary, version: manifest.version, sha256: manifest.sha256 };
}

function decryptEnvelope(envelope, privateKey) {
  if (envelope?.version !== SEALED_VERSION)
    throw new Error("browser_egress_envelope_version_invalid");
  const key = crypto.privateDecrypt(
    {
      key: privateKey,
      oaepHash: "sha256",
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    },
    Buffer.from(
      requireString(envelope.encryptedKey, "browser_egress_envelope_invalid"),
      "base64"
    )
  );
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(
      requireString(envelope.iv, "browser_egress_envelope_invalid"),
      "base64"
    )
  );
  decipher.setAuthTag(
    Buffer.from(
      requireString(envelope.tag, "browser_egress_envelope_invalid"),
      "base64"
    )
  );
  const plaintext = Buffer.concat([
    decipher.update(
      Buffer.from(
        requireString(
          envelope.ciphertext,
          "browser_egress_envelope_invalid",
          512_000
        ),
        "base64"
      )
    ),
    decipher.final(),
  ]);
  const config = safeJson(
    plaintext.toString("utf8"),
    "browser_egress_config_invalid"
  );
  if (config.version !== CLIENT_VERSION)
    throw new Error("browser_egress_config_version_invalid");
  if (new Date(config.expiresAt).getTime() <= Date.now())
    throw new Error("browser_egress_grant_expired");
  requireString(config.endpoint?.host, "browser_egress_endpoint_invalid", 255);
  requireString(
    config.endpoint?.serverName,
    "browser_egress_endpoint_invalid",
    255
  );
  requireString(
    config.transport?.uuid,
    "browser_egress_credential_invalid",
    64
  );
  requireString(
    config.transport?.realityPublicKey,
    "browser_egress_reality_invalid",
    512
  );
  requireString(
    config.transport?.realityShortId,
    "browser_egress_reality_invalid",
    64
  );
  return config;
}

class DesktopBrowserEgressRuntime {
  constructor({ app, safeStorage, log = () => {}, spawnImpl = spawn } = {}) {
    this.app = app;
    this.safeStorage = safeStorage;
    this.log = log;
    this.spawnImpl = spawnImpl;
    this.process = null;
    this.local = null;
    this.chromeBridge = null;
    this.config = null;
    const pair = crypto.generateKeyPairSync("rsa", {
      modulusLength: 3072,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    this.publicKey = pair.publicKey;
    this.privateKey = pair.privateKey;
    this.core = null;
    try {
      this.core = verifyCore(this.coreDir());
    } catch (error) {
      this.coreError = error.message;
    }
    this.loadPersistedConfig();
  }

  coreDir() {
    return process.env.ATHENA_BROWSER_EGRESS_CORE_DIR
      ? path.resolve(process.env.ATHENA_BROWSER_EGRESS_CORE_DIR)
      : path.join(
          process.resourcesPath || __dirname,
          "browser-egress",
          `${process.platform}-${process.arch}`
        );
  }

  configFile() {
    return path.join(
      this.app.getPath("userData"),
      "browser-egress",
      "device-config.bin"
    );
  }

  loadPersistedConfig() {
    try {
      if (!this.safeStorage?.isEncryptionAvailable?.()) return;
      const encrypted = fs.readFileSync(this.configFile());
      const config = safeJson(
        this.safeStorage.decryptString(encrypted),
        "browser_egress_persisted_config_invalid"
      );
      if (
        config.version === CLIENT_VERSION &&
        new Date(config.expiresAt).getTime() > Date.now()
      )
        this.config = config;
    } catch {}
  }

  capabilities() {
    return {
      proxyModes: this.core
        ? ["direct", "system", "athena_egress"]
        : ["direct", "system"],
      egressEnvelopeVersion: SEALED_VERSION,
      egressEncryptionPublicKey: this.publicKey,
      egressCoreAvailable: Boolean(this.core),
      egressCoreVersion: this.core?.version || null,
      egressCoreError: this.coreError || null,
    };
  }

  installSealedConfig(envelope) {
    if (!this.core)
      throw new Error(this.coreError || "browser_egress_core_unavailable");
    if (!this.safeStorage?.isEncryptionAvailable?.())
      throw new Error("browser_egress_os_credential_store_unavailable");
    const config = decryptEnvelope(envelope, this.privateKey);
    const file = this.configFile();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(
      temporary,
      this.safeStorage.encryptString(JSON.stringify(config)),
      { mode: 0o600, flag: "wx" }
    );
    fs.renameSync(temporary, file);
    this.config = config;
    return {
      installed: true,
      grantId: config.grantId,
      expiresAt: config.expiresAt,
    };
  }

  async stop() {
    if (this.chromeBridge) {
      this.chromeBridge.closeAllConnections?.();
      await new Promise((resolve) => this.chromeBridge.close(() => resolve()));
      this.chromeBridge = null;
    }
    if (this.process && this.process.exitCode == null) {
      this.process.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (this.process?.exitCode == null) this.process.kill("SIGKILL");
          resolve();
        }, 2_000);
        this.process.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.process = null;
    this.local = null;
  }

  async start() {
    if (!this.core)
      throw new Error(this.coreError || "browser_egress_core_unavailable");
    if (!this.config) throw new Error("browser_egress_config_missing");
    if (new Date(this.config.expiresAt).getTime() <= Date.now())
      throw new Error("browser_egress_grant_expired");
    await this.stop();
    const port = await randomPort();
    const username = `athena-${crypto.randomBytes(8).toString("hex")}`;
    const password = crypto.randomBytes(24).toString("base64url");
    const directory = path.join(
      this.app.getPath("userData"),
      "browser-egress",
      "runtime"
    );
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const configFile = path.join(directory, "config.json");
    const runtimeConfig = {
      log: { level: "warn", timestamp: true },
      dns: {
        servers: [
          {
            type: "tls",
            tag: "remote",
            server: "1.1.1.1",
            detour: "athena-egress",
          },
        ],
        final: "remote",
      },
      inbounds: [
        {
          type: "mixed",
          tag: "local-browser",
          listen: "127.0.0.1",
          listen_port: port,
          users: [{ username, password }],
        },
      ],
      outbounds: [
        {
          type: "vless",
          tag: "athena-egress",
          server: this.config.endpoint.host,
          server_port: Number(this.config.endpoint.port),
          uuid: this.config.transport.uuid,
          flow: this.config.transport.flow,
          tls: {
            enabled: true,
            server_name: this.config.endpoint.serverName,
            utls: { enabled: true, fingerprint: "chrome" },
            reality: {
              enabled: true,
              public_key: this.config.transport.realityPublicKey,
              short_id: this.config.transport.realityShortId,
            },
          },
        },
      ],
      route: { final: "athena-egress", auto_detect_interface: true },
    };
    fs.writeFileSync(configFile, `${JSON.stringify(runtimeConfig)}\n`, {
      mode: 0o600,
    });
    const checked = spawnSync(this.core.binary, ["check", "-c", configFile], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    if (checked.status !== 0)
      throw new Error("browser_egress_local_config_rejected");
    const child = this.spawnImpl(this.core.binary, ["run", "-c", configFile], {
      stdio: "ignore",
      windowsHide: true,
    });
    this.process = child;
    child.once("exit", (code, signal) => {
      this.log("Browser egress core exited", { code, signal });
      if (this.process === child) {
        this.process = null;
        this.local = null;
      }
    });
    try {
      await waitForPort(port);
    } catch (error) {
      child.kill("SIGTERM");
      throw error;
    }
    this.local = {
      host: "127.0.0.1",
      port,
      username,
      password,
      grantId: this.config.grantId,
    };
    const probe = await probeSocks(this.local);
    this.local.latencyMs = probe.latencyMs;
    return this.local;
  }

  async route(networkRoute) {
    const route = String(networkRoute || "system");
    if (route === "direct") {
      await this.stop();
      return {
        mode: "direct",
        network: {
          requestedRoute: route,
          effectiveRoute: route,
          connected: true,
          region: "local",
        },
      };
    }
    if (route === "system") {
      await this.stop();
      return {
        mode: "system",
        network: {
          requestedRoute: route,
          effectiveRoute: route,
          connected: true,
          region: "local",
        },
      };
    }
    if (route !== "athena_egress")
      throw new Error("browser_network_route_invalid");
    const local = this.local || (await this.start());
    return {
      mode: "fixed_servers",
      proxyRules: `socks5://${local.host}:${local.port}`,
      proxyBypassRules: "<-loopback>",
      network: {
        requestedRoute: route,
        effectiveRoute: route,
        connected: true,
        region: "overseas",
        grantExpiresAt: this.config.expiresAt,
        latencyMs: local.latencyMs,
      },
    };
  }

  handleProxyLogin(authInfo, callback) {
    if (
      authInfo?.isProxy &&
      this.local &&
      ["127.0.0.1", "localhost"].includes(String(authInfo.host)) &&
      Number(authInfo.port) === this.local.port
    ) {
      callback(this.local.username, this.local.password);
      return true;
    }
    return false;
  }

  async chromeProxyBridge() {
    const local = this.local || (await this.start());
    if (this.chromeBridge?.listening)
      return { host: "127.0.0.1", port: this.chromeBridge.address().port };
    const server = net.createServer((client) => {
      client.once("error", () => client.destroy());
      let received = Buffer.alloc(0);
      const timeout = setTimeout(() => client.destroy(), 10_000);
      const onData = async (chunk) => {
        received = Buffer.concat([received, chunk]);
        if (received.length > 16_384) return client.destroy();
        const boundary = received.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        client.removeListener("data", onData);
        clearTimeout(timeout);
        const [requestLine] = received
          .subarray(0, boundary)
          .toString("ascii")
          .split("\r\n");
        const match = requestLine.match(
          /^CONNECT\s+([^:\s]+|\[[^\]]+\]):(\d+)\s+HTTP\/1\.[01]$/i
        );
        if (!match) {
          client.end(
            "HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n"
          );
          return;
        }
        const host = match[1].replace(/^\[|\]$/g, "");
        const port = Number(match[2]);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
          client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
          return;
        }
        try {
          const upstream = await connectThroughAuthenticatedSocks(
            local,
            host,
            port
          );
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          const remainder = received.subarray(boundary + 4);
          if (remainder.length) upstream.write(remainder);
          client.pipe(upstream);
          upstream.pipe(client);
          upstream.once("error", () => client.destroy());
        } catch {
          client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        }
      };
      client.on("data", onData);
    });
    server.on("error", (error) =>
      this.log("Browser egress Chrome bridge failed", { code: error.code })
    );
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0 }, resolve);
    });
    this.chromeBridge = server;
    return { host: "127.0.0.1", port: server.address().port };
  }

  async close() {
    await this.stop();
    this.privateKey = null;
  }
}

module.exports = {
  CLIENT_VERSION,
  CORE_MANIFEST_VERSION,
  DesktopBrowserEgressRuntime,
  SEALED_VERSION,
  decryptEnvelope,
  verifyCore,
  probeSocks,
  privateAddressLiteral,
};
