import test from "node:test";
import assert from "node:assert/strict";
import {
  historyDetailForDevice,
  historyPriorityWindowForDevice,
  historyRequestOptionsForDevice,
  historySurfaceForDevice,
} from "./historyRequestOptions.js";

test("desktop history requests keep light detail", () => {
  assert.equal(historyDetailForDevice({ mobile: false }), "light");
  assert.equal(
    historyPriorityWindowForDevice({ mobile: false, fallback: 10 }),
    10
  );
  assert.deepEqual(
    historyRequestOptionsForDevice({
      mobile: false,
      limit: 20,
      priorityWindow: 10,
      beforeChatId: 50,
    }),
    {
      limit: 20,
      detail: "light",
      priorityWindow: 10,
      beforeChatId: 50,
    }
  );
});

test("mobile history requests use full detail so empty light messages are not rendered", () => {
  const options = historyRequestOptionsForDevice({
    mobile: true,
    limit: 20,
    priorityWindow: 10,
    beforeChatId: 50,
  });

  assert.equal(options.detail, "full");
  assert.equal(options.limit, 20);
  assert.equal(options.beforeChatId, 50);
  assert.equal(options.priorityWindow, Number.MAX_SAFE_INTEGER);
});

test("narrow viewports are treated as mobile history surfaces", () => {
  const narrowWindow = {
    innerWidth: 390,
    matchMedia: () => ({ matches: true }),
  };
  const options = historyRequestOptionsForDevice({
    mobile: false,
    windowLike: narrowWindow,
    limit: 20,
    priorityWindow: 10,
  });

  assert.equal(historySurfaceForDevice({ windowLike: narrowWindow }), "mobile");
  assert.equal(options.detail, "full");
  assert.equal(options.priorityWindow, Number.MAX_SAFE_INTEGER);
});

test("navigator mobile hints are treated as mobile history surfaces", () => {
  const options = historyRequestOptionsForDevice({
    mobile: false,
    navigatorLike: { userAgentData: { mobile: true } },
    limit: 20,
    priorityWindow: 10,
  });

  assert.equal(options.detail, "full");
  assert.equal(options.priorityWindow, Number.MAX_SAFE_INTEGER);
});
