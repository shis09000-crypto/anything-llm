import assert from "node:assert/strict";
import test from "node:test";

import {
  isHeavyFullscreenRoute,
  motionRouteKey,
  rawRouteKey,
  routeTransitionPolicy,
} from "./routeTransitionPolicy.js";

function route(pathname, search = "") {
  return {
    pathname,
    rawKey: rawRouteKey({ pathname, search }),
    motionKey: motionRouteKey({ pathname, search }),
  };
}

test("persistent settings routes share one soft surface key", () => {
  assert.equal(
    motionRouteKey({ pathname: "/settings/interface" }),
    motionRouteKey({ pathname: "/settings/llm-preference" })
  );
  assert.notEqual(
    motionRouteKey({ pathname: "/settings/crypto-center" }),
    motionRouteKey({ pathname: "/settings/interface" })
  );
});

test("POP transitions skip animation and exiting layers", () => {
  const policy = routeTransitionPolicy({
    navigationType: "POP",
    previous: route("/settings/crypto-center"),
    next: route("/settings/interface"),
  });

  assert.equal(policy.skipTransition, true);
  assert.equal(policy.skipExitLayer, true);
  assert.equal(policy.phase, "pop-skip");
  assert.equal(policy.reason, "heavy-fullscreen-pop");
});

test("leaving heavy fullscreen routes skips the exiting layer on PUSH", () => {
  const policy = routeTransitionPolicy({
    navigationType: "PUSH",
    previous: route("/settings/crypto-center"),
    next: route("/settings/interface"),
  });

  assert.equal(policy.skipTransition, false);
  assert.equal(policy.skipExitLayer, true);
  assert.equal(policy.phase, "transitioning");
  assert.equal(policy.reason, "heavy-fullscreen-route");
});

test("returning from settings to workspace chat skips route exit animation", () => {
  const policy = routeTransitionPolicy({
    navigationType: "PUSH",
    previous: route("/settings/interface"),
    next: route("/workspace/demo/t/thread-a"),
  });

  assert.equal(policy.skipTransition, true);
  assert.equal(policy.skipExitLayer, true);
  assert.equal(policy.phase, "return-to-chat-skip");
  assert.equal(policy.reason, "return-to-chat");
});

test("normal PUSH transitions can animate", () => {
  const policy = routeTransitionPolicy({
    navigationType: "PUSH",
    previous: route("/login"),
    next: route("/workspace/demo"),
  });

  assert.equal(policy.skipTransition, false);
  assert.equal(policy.skipExitLayer, false);
  assert.equal(policy.reason, "route-change");
});

test("heavy fullscreen matcher covers crypto center and agent builder", () => {
  assert.equal(isHeavyFullscreenRoute("/settings/crypto-center"), true);
  assert.equal(isHeavyFullscreenRoute("/settings/agents/builder/new"), true);
  assert.equal(isHeavyFullscreenRoute("/settings/interface"), false);
});
