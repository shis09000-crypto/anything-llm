/* global describe, afterAll, test, expect */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  PURPOSES,
  SUITE_IDS,
  cryptoSuite,
  supportsNodeSignatureSuite,
} = require("../../utils/security/cryptoSuiteRegistry");
const {
  authorizeInvocation,
  issueInvocationCredential,
  resetCapabilityBrokerForTests,
} = require("../../utils/plugins/capabilityBroker");

const pqSuite = cryptoSuite(SUITE_IDS.PLUGIN_CAPABILITY_MLDSA65_V2, {
  purpose: PURPOSES.PLUGIN_CAPABILITY,
});
const nativeHybridTest = supportsNodeSignatureSuite(pqSuite) ? test : test.skip;
const temporaryDirectories = [];

function writeKey(filePath, key, type) {
  fs.writeFileSync(
    filePath,
    key.export({
      format: "pem",
      type,
    }),
    { mode: 0o600 }
  );
}

describe("native hybrid plugin capability", () => {
  afterAll(() => {
    for (const directory of temporaryDirectories)
      fs.rmSync(directory, { recursive: true, force: true });
  });

  nativeHybridTest(
    "round-trips Ed25519 and ML-DSA-65 without HMAC fallback",
    async () => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "athena-plugin-capability-")
      );
      temporaryDirectories.push(directory);
      const ed25519 = crypto.generateKeyPairSync("ed25519");
      const mlDSA65 = crypto.generateKeyPairSync("ml-dsa-65");
      const files = {
        edPrivate: path.join(directory, "ed25519-private.pem"),
        edPublic: path.join(directory, "ed25519-public.pem"),
        pqPrivate: path.join(directory, "mldsa65-private.pem"),
        pqPublic: path.join(directory, "mldsa65-public.pem"),
      };
      writeKey(files.edPrivate, ed25519.privateKey, "pkcs8");
      writeKey(files.edPublic, ed25519.publicKey, "spki");
      writeKey(files.pqPrivate, mlDSA65.privateKey, "pkcs8");
      writeKey(files.pqPublic, mlDSA65.publicKey, "spki");
      const env = {
        ATHENA_PLUGIN_CAPABILITY_ED25519_KEY_ID: "ed25519-test",
        ATHENA_PLUGIN_CAPABILITY_ED25519_PRIVATE_KEY_FILE: files.edPrivate,
        ATHENA_PLUGIN_CAPABILITY_ED25519_PUBLIC_KEY_FILE: files.edPublic,
        ATHENA_PLUGIN_CAPABILITY_MLDSA65_KEY_ID: "mldsa65-test",
        ATHENA_PLUGIN_CAPABILITY_MLDSA65_PRIVATE_KEY_FILE: files.pqPrivate,
        ATHENA_PLUGIN_CAPABILITY_MLDSA65_PUBLIC_KEY_FILE: files.pqPublic,
      };
      const request = {
        serviceIdentity: "crypto-account",
        tool: "crypto_account_overview",
        args: {},
        manifest: {
          approvalClass: "account-private-read",
          resultPolicy: "account-private/summary-only",
        },
        subject: "tool-invocation:native-hybrid-test",
        requireHybrid: true,
        env,
      };
      resetCapabilityBrokerForTests();
      const credential = issueInvocationCredential(request);

      await expect(
        authorizeInvocation({ ...request, credential })
      ).resolves.toMatchObject({
        version: "athena-plugin-capability:v2",
        audience: "crypto-account",
        subject: "tool-invocation:native-hybrid-test",
      });
    }
  );
});
