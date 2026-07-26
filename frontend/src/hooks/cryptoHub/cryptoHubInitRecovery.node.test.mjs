import assert from "node:assert/strict";
import test from "node:test";

import {
  CRYPTO_HUB_INIT_RETRY_DELAYS_MS,
  shouldRetryCryptoHubInit,
} from "./cryptoHubInitRecovery.js";

test("Crypto Hub init retries transport and gateway failures", () => {
  for (const status of [0, 502, 503, 504]) {
    assert.equal(shouldRetryCryptoHubInit({ status }), true);
  }
  assert.deepEqual(CRYPTO_HUB_INIT_RETRY_DELAYS_MS, [0, 1_000, 2_500, 5_000]);
});

test("Crypto Hub init does not retry auth, validation, or abort failures", () => {
  for (const status of [400, 401, 403, 404, 409, 500]) {
    assert.equal(shouldRetryCryptoHubInit({ status }), false);
  }
  assert.equal(
    shouldRetryCryptoHubInit({ name: "AbortError", status: 0 }),
    false
  );
});
