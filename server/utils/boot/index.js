const {
  TelemetryRepository: Telemetry,
} = require("../../repositories/telemetryRepository");
const { BackgroundService } = require("../BackgroundWorkers");
const { EncryptionManager } = require("../EncryptionManager");
const { CommunicationKey } = require("../comKey");
const setupTelemetry = require("../telemetry");
const eagerLoadContextWindows = require("./eagerLoadContextWindows");
const markOnboarded = require("./markOnboarded");
const { PushNotifications } = require("../PushNotifications");
const { TelegramBotService } = require("../telegramBot");
const { cleanupOpenClawWeixinLoginChild } = require("../openclawWeixin");
const MCPHypervisor = require("../MCP/hypervisor");
const { backgroundInlineEnabled } = require("../runtimeRole");
const {
  securityState,
  waitForSecurityBootstrap,
} = require("../security/keyRuntimeState");
const { runtimeCoordinator } = require("../runtimeCoordinator");
const {
  _internals: { drainBroadcastEvents },
} = require("../broadcast");
const { drainSyncPushQueue } = require("../nativePush/apnsProvider");

let shutdownHooksRegistered = false;
let backgroundService = null;

function bootBackgroundService() {
  if (securityState().quarantined) {
    console.error(
      "[BackgroundWorkerService] Disabled while key custody is quarantined."
    );
    return null;
  }
  if (!backgroundInlineEnabled()) {
    console.log(
      "\x1b[36m[BackgroundWorkerService]\x1b[0m Inline background workers disabled for this runtime role."
    );
    return null;
  }
  const service = new BackgroundService();
  backgroundService = service;
  return service;
}

runtimeCoordinator.register({
  name: "background-workers",
  order: 30,
  stopOrder: 10,
  start: async () => {
    const service = bootBackgroundService();
    if (service) await service.boot();
  },
  stop: async () => {
    if (backgroundService) await backgroundService.stop();
    backgroundService = null;
  },
});
runtimeCoordinator.register({
  name: "push-and-bot",
  order: 40,
  stopOrder: 15,
  start: async () => {
    await PushNotifications.setupPushNotificationService();
    await TelegramBotService.bootIfActive();
  },
  stop: async () => {
    await new TelegramBotService().stop();
  },
});
runtimeCoordinator.register({
  name: "external-child-processes",
  order: 45,
  stopOrder: 70,
  stop: async () => {
    await Promise.all([
      cleanupOpenClawWeixinLoginChild(),
      MCPHypervisor._instance?.shutdownMCPServers?.() || Promise.resolve(),
    ]);
  },
});
runtimeCoordinator.register({
  name: "telemetry-flush",
  order: 46,
  stopOrder: 71,
  stop: async () => Promise.resolve(Telemetry.flush()),
});
runtimeCoordinator.register({
  name: "broadcast-durable-commits",
  order: 50,
  stopOrder: 90,
  stop: drainBroadcastEvents,
});
runtimeCoordinator.register({
  name: "native-push-drain",
  order: 51,
  stopOrder: 95,
  stop: drainSyncPushQueue,
});

// TLS 1.3 cipher suites are selected by Node/OpenSSL automatically. The
// explicit cipher list below constrains TLS 1.2 to modern AEAD suites.
const STRONG_TLS_12_CIPHERS = [
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
].join(":");

function httpsServerOptions({ key, cert }) {
  return {
    key,
    cert,
    minVersion: "TLSv1.2",
    honorCipherOrder: true,
    ciphers: STRONG_TLS_12_CIPHERS,
  };
}

// Testing SSL? You can make a self signed certificate and point the ENVs to that location
// make a directory in server called 'sslcert' - cd into it
// - openssl genrsa -aes256 -passout pass:gsahdg -out server.pass.key 4096
// - openssl rsa -passin pass:gsahdg -in server.pass.key -out server.key
// - rm server.pass.key
// - openssl req -new -key server.key -out server.csr
// Update .env keys with the correct values and boot. These are temporary and not real SSL certs - only use for local.
// Test with https://localhost:3001/api/ping
// build and copy frontend to server/public with correct API_BASE and start server in prod model and all should be ok
function bootSSL(app, port = 3001) {
  try {
    registerShutdownHooks();
    console.log(
      `\x1b[33m[SSL BOOT ENABLED]\x1b[0m Loading the certificate and key for HTTPS mode...`
    );
    const fs = require("fs");
    const https = require("https");
    const privateKey = fs.readFileSync(process.env.HTTPS_KEY_PATH);
    const certificate = fs.readFileSync(process.env.HTTPS_CERT_PATH);
    const credentials = httpsServerOptions({
      key: privateKey,
      cert: certificate,
    });
    const server = https.createServer(credentials, app);

    runtimeCoordinator.attachServer(server);
    server
      .listen(port, () => void finishBoot("HTTPS", port))
      .on("error", catchSigTerms);

    require("@mintplex-labs/express-ws").default(app, server);
    return { app, server };
  } catch (e) {
    if (process.env.NODE_ENV === "production") {
      console.error(
        `\x1b[31m[SSL BOOT FAILED]\x1b[0m ${e.message} - refusing to fall back to HTTP in production.`,
        {
          ENABLE_HTTPS: process.env.ENABLE_HTTPS,
          HTTPS_KEY_PATH: process.env.HTTPS_KEY_PATH,
          HTTPS_CERT_PATH: process.env.HTTPS_CERT_PATH,
          stacktrace: e.stack,
        }
      );
      throw e;
    }

    console.error(
      `\x1b[31m[SSL BOOT FAILED]\x1b[0m ${e.message} - falling back to HTTP boot.`,
      {
        ENABLE_HTTPS: process.env.ENABLE_HTTPS,
        HTTPS_KEY_PATH: process.env.HTTPS_KEY_PATH,
        HTTPS_CERT_PATH: process.env.HTTPS_CERT_PATH,
        stacktrace: e.stack,
      }
    );
    return bootHTTP(app, port);
  }
}

function bootHTTP(app, port = 3001) {
  if (!app) throw new Error('No "app" defined - crashing!');
  registerShutdownHooks();

  const server = app.listen(port, () => void finishBoot("HTTP", port));
  runtimeCoordinator.attachServer(server);
  server.on("error", catchSigTerms);
  return { app, server };
}

async function finishBoot(mode, port) {
  try {
    await waitForSecurityBootstrap();
    await markOnboarded();
    await setupTelemetry();
    new CommunicationKey(true);
    new EncryptionManager();
    await eagerLoadContextWindows();
    await runtimeCoordinator.start();
    console.log(`Primary server in ${mode} mode listening on port ${port}`);
  } catch (error) {
    console.error(`[Runtime] ${mode} startup failed.`, error);
    process.exitCode = 1;
    await runtimeCoordinator.shutdown();
  }
}

function registerShutdownHooks() {
  if (shutdownHooksRegistered) return;
  shutdownHooksRegistered = true;

  process.once("SIGUSR2", () => void shutdownForSignal("SIGUSR2"));
  process.once("SIGINT", () => void shutdownForSignal("SIGINT"));
  process.once("SIGTERM", () => void shutdownForSignal("SIGTERM"));
}

async function shutdownForSignal(signal) {
  runtimeCoordinator.ready = false;
  const result = await runtimeCoordinator.shutdown();
  if (signal === "SIGUSR2") process.kill(process.pid, "SIGUSR2");
  else process.exit(result.timedOut ? 1 : 0);
}

function catchSigTerms(error) {
  runtimeCoordinator.ready = false;
  console.error("[Runtime] HTTP server error.", error);
  process.exitCode = 1;
  void runtimeCoordinator.shutdown().finally(() => process.exit(1));
}

module.exports = {
  bootBackgroundService,
  bootHTTP,
  bootSSL,
  httpsServerOptions,
};
