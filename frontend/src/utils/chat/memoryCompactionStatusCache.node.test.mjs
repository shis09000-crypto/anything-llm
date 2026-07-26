import assert from "node:assert/strict";
import test from "node:test";

import {
  clearMemoryCompactionStatusCache,
  readMemoryCompactionStatus,
  writeMemoryCompactionStatus,
} from "./memoryCompactionStatusCache.js";

test("retains the last successful memory status across a view remount", () => {
  clearMemoryCompactionStatusCache();
  writeMemoryCompactionStatus("workspace:thread:user", {
    usedTokens: 120,
    limitTokens: 1_000,
    ratio: 0.12,
  });

  assert.deepEqual(readMemoryCompactionStatus("workspace:thread:user"), {
    usedTokens: 120,
    limitTokens: 1_000,
    ratio: 0.12,
  });
  assert.equal(readMemoryCompactionStatus("other-scope"), null);
});
