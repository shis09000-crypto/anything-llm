import test from "node:test";
import assert from "node:assert/strict";
import { resolveModelChromeState } from "./modelChromeState.js";

test("thread model wins over workspace and system defaults", () => {
  const state = resolveModelChromeState({
    thread: { chatModel: "deepseek-v4-flash" },
    workspace: {
      chatModel: "deepseek-v4-pro",
      chatProvider: "deepseek",
    },
    settings: {
      LLMModel: "system-model",
      LLMProvider: "system-provider",
    },
  });

  assert.deepEqual(state, {
    modelName: "deepseek-v4-flash",
    provider: "deepseek",
  });
});

test("workspace model and provider win over system defaults", () => {
  const state = resolveModelChromeState({
    workspace: {
      chatModel: "workspace-model",
      chatProvider: "workspace-provider",
    },
    settings: {
      LLMModel: "system-model",
      LLMProvider: "system-provider",
    },
  });

  assert.deepEqual(state, {
    modelName: "workspace-model",
    provider: "workspace-provider",
  });
});

test("missing workspace model falls back to system model", () => {
  const state = resolveModelChromeState({
    workspace: {
      chatModel: null,
      chatProvider: undefined,
    },
    settings: {
      LLMModel: "deepseek-v4-pro",
      LLMProvider: "deepseek",
    },
  });

  assert.deepEqual(state, {
    modelName: "deepseek-v4-pro",
    provider: "deepseek",
  });
});

test("blank workspace values are treated as unset", () => {
  const state = resolveModelChromeState({
    workspace: {
      chatModel: "   ",
      chatProvider: "",
    },
    settings: {
      LLMModel: "deepseek-v4-pro",
      LLMProvider: "deepseek",
    },
  });

  assert.deepEqual(state, {
    modelName: "deepseek-v4-pro",
    provider: "deepseek",
  });
});

test("missing workspace and system values resolve to empty strings", () => {
  const state = resolveModelChromeState({
    workspace: {},
    settings: {},
  });

  assert.deepEqual(state, {
    modelName: "",
    provider: "",
  });
});
