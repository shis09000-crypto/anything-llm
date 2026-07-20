import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const athenaRoot = path.resolve(here, "..");
const repoRoot = path.resolve(athenaRoot, "..", "..");
const crate = path.join(athenaRoot, "Native", "AthenaOpaqueCore");
const manifest = path.join(crate, "Cargo.toml");
const target = path.join(crate, "target", "interop");
const binary = path.join(target, "release", "athena-opaque-cli");
const require = createRequire(import.meta.url);
const opaque = require(
  path.join(repoRoot, "server", "node_modules", "@serenity-kit", "opaque")
);

function run(command, input) {
  const result = spawnSync(binary, [command], {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (result.status !== 0) {
    throw new Error(`native OPAQUE command failed: ${command}`);
  }
  const envelope = JSON.parse(result.stdout);
  if (!envelope.ok) {
    throw new Error(envelope.error || `native OPAQUE ${command} failed`);
  }
  return envelope.value;
}

const build = spawnSync(
  "cargo",
  ["build", "--manifest-path", manifest, "--release", "--bin", "athena-opaque-cli"],
  {
    env: { ...process.env, CARGO_TARGET_DIR: target },
    stdio: "inherit",
  }
);
if (build.status !== 0) process.exit(build.status ?? 1);

await opaque.ready;
const secret = "native-and-web-compatible-device-secret";
const deviceId = "interop_device_1234567890";
const identifiers = { client: deviceId, server: "Athena" };
const userIdentifier = `athena:user:7:device:${deviceId}`;
const setup = opaque.server.createSetup();
const expectedPublicKey = opaque.server.getPublicKey(setup);

const registrationStart = run("start-registration", secret);
const { registrationResponse } = opaque.server.createRegistrationResponse({
  serverSetup: setup,
  userIdentifier,
  registrationRequest: registrationStart.registrationRequest,
});
const registrationFinish = run(
  "finish-registration",
  JSON.stringify({
    password: secret,
    clientRegistrationState: registrationStart.clientRegistrationState,
    registrationResponse,
    clientIdentifier: deviceId,
    serverIdentifier: "Athena",
  })
);
if (registrationFinish.serverStaticPublicKey !== expectedPublicKey) {
  throw new Error("registration server public key mismatch");
}

const loginStart = run("start-login", secret);
const serverLogin = opaque.server.startLogin({
  serverSetup: setup,
  registrationRecord: registrationFinish.registrationRecord,
  startLoginRequest: loginStart.startLoginRequest,
  userIdentifier,
  identifiers,
});
const loginFinish = run(
  "finish-login",
  JSON.stringify({
    password: secret,
    clientLoginState: loginStart.clientLoginState,
    loginResponse: serverLogin.loginResponse,
    clientIdentifier: deviceId,
    serverIdentifier: "Athena",
  })
);
opaque.server.finishLogin({
  serverLoginState: serverLogin.serverLoginState,
  finishLoginRequest: loginFinish.finishLoginRequest,
  identifiers,
});
if (loginFinish.serverStaticPublicKey !== expectedPublicKey) {
  throw new Error("login server public key mismatch");
}

console.log("Rust client and Serenity OPAQUE server are interoperable.");
