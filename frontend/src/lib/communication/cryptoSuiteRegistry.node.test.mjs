import test from "node:test";
import assert from "node:assert/strict";
import {
  CRYPTO_SUITE_IDS,
  CRYPTO_SUITE_PURPOSES,
  cryptoSuite,
  preferredCryptoSuite,
} from "./cryptoSuiteRegistry.js";

test("web crypto registry selects only available request suites", () => {
  assert.equal(
    preferredCryptoSuite(CRYPTO_SUITE_PURPOSES.requestSignature)?.suiteId,
    CRYPTO_SUITE_IDS.requestDeviceP256V2
  );
  assert.equal(
    cryptoSuite(
      CRYPTO_SUITE_IDS.requestDeviceP256V2,
      CRYPTO_SUITE_PURPOSES.deviceKey
    ),
    null
  );
});

test("web crypto registry applies version and lifecycle gates", () => {
  assert.equal(
    cryptoSuite(
      CRYPTO_SUITE_IDS.requestDeviceP256V2,
      CRYPTO_SUITE_PURPOSES.requestSignature,
      { clientVersion: "0.0.0", now: Date.parse("2019-12-31T23:59:59Z") }
    ),
    null
  );
  assert.equal(
    cryptoSuite(
      CRYPTO_SUITE_IDS.requestDeviceP256V2,
      CRYPTO_SUITE_PURPOSES.requestSignature,
      { clientVersion: "0.0.0", now: Date.parse("2026-07-23T00:00:00Z") }
    )?.suiteId,
    CRYPTO_SUITE_IDS.requestDeviceP256V2
  );
});
