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

test("reports a refresh outage as disconnected even when cached data remains", () => {
  assert.equal(
    resolvePrivateConnectionStatus({
      hasTrustedData: true,
      requestError: "refresh failed",
      upstreamStatus: "connected",
    }),
    "disconnected"
  );
});

test("reports degraded only when the live upstream explicitly returns partial data", () => {
  assert.equal(
    resolvePrivateConnectionStatus({
      hasTrustedData: true,
      requestError: null,
      upstreamStatus: "degraded",
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
