import assert from "node:assert/strict";
import test from "node:test";
import { COMPOSER_ADD_MENU_ITEMS } from "./composerAddMenu.js";

test("desktop composer add menu keeps the Codex order", () => {
  assert.deepEqual(
    [...COMPOSER_ADD_MENU_ITEMS],
    ["file", "goal", "plan", "tools", "test"]
  );
});
