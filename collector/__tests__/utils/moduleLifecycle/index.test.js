/* eslint-env jest */

const {
  CollectorModuleLifecycle,
} = require("../../../utils/moduleLifecycle");

describe("Collector module lifecycle adapter", () => {
  test("drains, quiesces and resumes without changing Collector task logic", async () => {
    const runtime = new CollectorModuleLifecycle();
    runtime.initialize();
    runtime.markReady();
    expect(runtime.snapshot()).toMatchObject({
      moduleId: "collector",
      ready: true,
      lifecycle: { state: "ready" },
    });

    await runtime.drain("test_drain");
    expect(runtime.snapshot()).toMatchObject({
      ready: false,
      lifecycle: { state: "draining" },
    });
    await runtime.quiesce({ reasonCode: "test_quiesce" });
    expect(runtime.snapshot().lifecycle.state).toBe("quiesced");
    await runtime.resume("test_resume");
    expect(runtime.snapshot()).toMatchObject({
      ready: true,
      lifecycle: { state: "ready" },
    });
    await runtime.stop();
    expect(runtime.snapshot().lifecycle.state).toBe("stopped");
  });
});
