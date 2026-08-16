const {
  ModuleLifecycle,
} = require("../../utils/microModules/lifecycle");

describe("ModuleLifecycle", () => {
  test("implements the registered to ready to quiesced lifecycle", () => {
    const transitions = [];
    const lifecycle = new ModuleLifecycle({
      moduleId: "reader-worker",
      version: "2.5.0",
      manifestFingerprint: "a".repeat(64),
      onTransition: (event) => transitions.push(event),
    });

    lifecycle.transition("initializing", { reasonCode: "runtime_start" });
    lifecycle.transition("ready", { reasonCode: "self_test_passed" });
    const heartbeat = lifecycle.heartbeat({ ready: true });
    lifecycle.transition("draining", { reasonCode: "release_drain" });
    lifecycle.transition("quiesced", { reasonCode: "drain_completed" });

    expect(heartbeat).toMatchObject({
      moduleId: "reader-worker",
      ready: true,
      state: "ready",
    });
    expect(lifecycle.snapshot()).toMatchObject({
      state: "quiesced",
      sequence: 4,
    });
    expect(transitions.map((event) => `${event.from}:${event.to}`)).toEqual([
      "registered:initializing",
      "initializing:ready",
      "ready:draining",
      "draining:quiesced",
    ]);
  });

  test("denies undefined or unsafe transition shortcuts", () => {
    const lifecycle = new ModuleLifecycle({ moduleId: "crypto-market" });
    expect(() => lifecycle.transition("ready")).toThrow(
      "module_lifecycle_transition_denied"
    );
    expect(() => lifecycle.transition("unknown")).toThrow(
      "module_lifecycle_state_invalid"
    );
  });
});
