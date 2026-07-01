import test from "node:test";
import assert from "node:assert/strict";
import {
  CUSTOM_TEXT_SIZE,
  DEFAULT_TEXT_SIZE,
  TEXT_SIZE_CHANGE_EVENT,
  TEXT_SIZE_CUSTOM_KEY,
  TEXT_SIZE_KEY,
  applySyncedTextSizePreference,
  flushPendingTextSizePreference,
  getTextSizePreference,
  saveTextSizePreference,
  setTextSizePreferencePersisterForTests,
} from "./textSize.js";

function installWindow() {
  const values = new Map();
  const events = [];
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  };
  globalThis.window = {
    localStorage: {
      getItem: (key) => (values.has(key) ? values.get(key) : null),
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
    dispatchEvent: (event) => events.push(event),
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args),
  };
  return { events, values };
}

test("applySyncedTextSizePreference stores account font size and broadcasts it", () => {
  const { events, values } = installWindow();

  const preference = applySyncedTextSizePreference({
    textSize: CUSTOM_TEXT_SIZE,
    customTextSizePx: 19,
  });

  assert.equal(preference.value, CUSTOM_TEXT_SIZE);
  assert.equal(preference.px, 19);
  assert.equal(values.get(TEXT_SIZE_KEY), CUSTOM_TEXT_SIZE);
  assert.equal(values.get(TEXT_SIZE_CUSTOM_KEY), "19");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, TEXT_SIZE_CHANGE_EVENT);
  assert.equal(events[0].detail.px, 19);
});

test("applySyncedTextSizePreference rejects invalid remote values", () => {
  const { values } = installWindow();

  const preference = applySyncedTextSizePreference({
    textSize: "oversized",
    customTextSizePx: 999,
  });

  assert.equal(preference.value, DEFAULT_TEXT_SIZE);
  assert.equal(preference.px, getTextSizePreference(DEFAULT_TEXT_SIZE).px);
  assert.equal(values.get(TEXT_SIZE_CUSTOM_KEY), "26");
});

test("saveTextSizePreference keeps existing custom behavior for manual changes", () => {
  const { events, values } = installWindow();

  const preference = saveTextSizePreference(CUSTOM_TEXT_SIZE, 18);

  assert.equal(preference.value, CUSTOM_TEXT_SIZE);
  assert.equal(values.get(TEXT_SIZE_KEY), CUSTOM_TEXT_SIZE);
  assert.equal(values.get(TEXT_SIZE_CUSTOM_KEY), "18");
  assert.equal(events.at(-1).detail.px, 18);
});

test("saveTextSizePreference debounces account sync and persists only the final value", async () => {
  const { events, values } = installWindow();
  const persisted = [];
  setTextSizePreferencePersisterForTests(async (payload) => {
    persisted.push(payload);
  });

  saveTextSizePreference("small");
  saveTextSizePreference(CUSTOM_TEXT_SIZE, 18);
  saveTextSizePreference(CUSTOM_TEXT_SIZE, 22);

  assert.equal(values.get(TEXT_SIZE_KEY), CUSTOM_TEXT_SIZE);
  assert.equal(values.get(TEXT_SIZE_CUSTOM_KEY), "22");
  assert.equal(events.at(-1).detail.px, 22);
  assert.deepEqual(persisted, []);

  const flushed = await flushPendingTextSizePreference();

  assert.deepEqual(flushed, {
    textSize: CUSTOM_TEXT_SIZE,
    customTextSizePx: 22,
  });
  assert.deepEqual(persisted, [
    {
      textSize: CUSTOM_TEXT_SIZE,
      customTextSizePx: 22,
    },
  ]);

  setTextSizePreferencePersisterForTests(null);
});
