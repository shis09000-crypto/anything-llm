import assert from "node:assert/strict";
import test from "node:test";
import { resolvePrivateConnectionStatus } from "./cryptoPrivateConnectionStatus.js";

test("reports an outage as disconnected when no trusted private data exists", () => {
  assert.equal(
    resolvePrivateConnectionStatus({
      hasTrustedData: false,
      requestError: "account upstream unavailable",
      upstreamStatus: null,
    }),
    "disconnected"
  );
});

test("reports degraded only while trusted cached data remains available", () => {
  assert.equal(
    resolvePrivateConnectionStatus({
      hasTrustedData: true,
      requestError: "refresh failed",
      upstreamStatus: "connected",
    }),
    "degraded"
  );
});

test("preserves an explicit upstream disconnect", () => {
  assert.equal(
    resolvePrivateConnectionStatus({
      hasTrustedData: true,
      requestError: null,
      upstreamStatus: "disconnected",
    }),
    "disconnected"
  );
});
