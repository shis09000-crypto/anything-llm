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

test("iPad and Android tablets keep desktop history surface by default", () => {
  const ipadWindow = {
    innerWidth: 820,
    matchMedia: (query) => ({
      matches:
        query.includes("pointer: coarse") ||
        query.includes("any-pointer: coarse") ||
        query.includes("max-width"),
    }),
    navigator: {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      platform: "MacIntel",
      maxTouchPoints: 5,
    },
  };
  const ipadOptions = historyRequestOptionsForDevice({
    mobile: false,
    windowLike: ipadWindow,
    navigatorLike: ipadWindow.navigator,
    limit: 20,
    priorityWindow: 10,
  });

  assert.equal(
    historySurfaceForDevice({
      windowLike: ipadWindow,
      navigatorLike: ipadWindow.navigator,
    }),
    "desktop"
  );
  assert.equal(ipadOptions.detail, "light");
  assert.equal(ipadOptions.priorityWindow, 10);

  const androidTabletWindow = {
    innerWidth: 900,
    matchMedia: (query) => ({
      matches:
        query.includes("pointer: coarse") ||
        query.includes("any-pointer: coarse"),
    }),
    navigator: {
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      platform: "Linux armv8l",
      maxTouchPoints: 10,
    },
  };

  assert.equal(
    historySurfaceForDevice({
      windowLike: androidTabletWindow,
      navigatorLike: androidTabletWindow.navigator,
    }),
    "desktop"
  );
});

test("Android phone history surface remains mobile even on a wide viewport", () => {
  const androidPhoneWindow = {
    innerWidth: 820,
    matchMedia: (query) => ({
      matches:
        query.includes("pointer: coarse") ||
        query.includes("any-pointer: coarse"),
    }),
    navigator: {
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro Build/AP1A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
      platform: "Linux armv8l",
      maxTouchPoints: 5,
    },
  };

  assert.equal(
    historySurfaceForDevice({
      windowLike: androidPhoneWindow,
      navigatorLike: androidPhoneWindow.navigator,
    }),
    "mobile"
  );
});
