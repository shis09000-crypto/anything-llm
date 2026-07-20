const {
  mutationBatchConcurrency,
  runMutationBatch,
} = require("../../utils/syncV2/mutationBatch");

describe("Sync V2 bounded mutation batch", () => {
  test("preserves same-node order and original result order", async () => {
    const calls = [];
    const mutations = [
      { nodeKey: "node-a", value: 1 },
      { nodeKey: "node-b", value: 2 },
      { nodeKey: "node-a", value: 3 },
    ];
    const results = await runMutationBatch(
      mutations,
      async (mutation) => {
        calls.push(`${mutation.nodeKey}:start:${mutation.value}`);
        await new Promise((resolve) => setTimeout(resolve, mutation.value === 1 ? 5 : 0));
        calls.push(`${mutation.nodeKey}:end:${mutation.value}`);
        return mutation.value * 10;
      },
      { concurrency: 2 }
    );

    expect(calls.indexOf("node-a:end:1")).toBeLessThan(
      calls.indexOf("node-a:start:3")
    );
    expect(results).toEqual([
      { status: "fulfilled", value: 10 },
      { status: "fulfilled", value: 20 },
      { status: "fulfilled", value: 30 },
    ]);
  });

  test("never exceeds the configured independent-node concurrency", async () => {
    let active = 0;
    let peak = 0;
    const releases = [];
    const worker = jest.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => releases.push(resolve));
      active -= 1;
    });
    const running = runMutationBatch(
      Array.from({ length: 6 }, (_, index) => ({ nodeKey: `node-${index}` })),
      worker,
      { concurrency: 2 }
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(active).toBe(2);
    while (releases.length) {
      releases.shift()();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await running;
    expect(peak).toBe(2);
  });

  test("captures one failure without stopping other lanes", async () => {
    const results = await runMutationBatch(
      [{ nodeKey: "a" }, { nodeKey: "b" }],
      async (mutation) => {
        if (mutation.nodeKey === "a") throw new Error("failed-a");
        return "ok-b";
      }
    );
    expect(results[0]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: "failed-a" }),
    });
    expect(results[1]).toEqual({ status: "fulfilled", value: "ok-b" });
  });

  test("bounds invalid configuration to the safe range", () => {
    expect(mutationBatchConcurrency("0")).toBe(1);
    expect(mutationBatchConcurrency("999")).toBe(8);
    expect(mutationBatchConcurrency("invalid")).toBe(4);
  });
});
