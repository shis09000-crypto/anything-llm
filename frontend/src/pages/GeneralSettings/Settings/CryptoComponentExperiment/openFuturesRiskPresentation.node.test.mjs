import assert from "node:assert/strict";
import test from "node:test";

import {
  LIQUIDATION_RISK_META,
  liquidationRiskPresentation,
} from "./openFuturesRiskPresentation.js";

const CONTRACT_LEVELS = [
  "safe",
  "watch",
  "danger",
  "critical",
  "extreme",
  "unavailable",
];

test("every liquidation risk contract value has display metadata", () => {
  for (const level of CONTRACT_LEVELS) {
    const meta = liquidationRiskPresentation(level);
    assert.equal(meta, LIQUIDATION_RISK_META[level]);
    assert.equal(typeof meta.label, "string");
    assert.ok(meta.label.length > 0);
    assert.equal(typeof meta.lights, "number");
  }
});

test("unavailable and future unknown values degrade without throwing", () => {
  assert.deepEqual(liquidationRiskPresentation("unavailable"), {
    label: "暂不可用",
    lights: 0,
  });
  assert.equal(
    liquidationRiskPresentation("future-provider-state"),
    LIQUIDATION_RISK_META.unavailable
  );
  assert.equal(
    liquidationRiskPresentation(undefined),
    LIQUIDATION_RISK_META.unavailable
  );
});
