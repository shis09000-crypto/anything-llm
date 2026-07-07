const { BackgroundWorkerRuntime } = require("../../utils/backgroundWorker/runtime");

describe("BackgroundWorkerRuntime", () => {
  test("starts BackgroundService and exposes a snapshot", async () => {
    const boot = jest.fn(async () => {});
    const jobs = jest.fn(() => [{ name: "system-patrol" }]);
    const runtime = new BackgroundWorkerRuntime({
      now: () => new Date("2026-07-07T00:00:00.000Z"),
      backgroundServiceFactory: () => ({ boot, jobs }),
    });

    await expect(runtime.start()).resolves.toMatchObject({
      role: "background-worker",
      status: "running",
      inline: false,
      jobs: ["system-patrol"],
    });
    expect(boot).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot()).toMatchObject({
      role: "background-worker",
      status: "running",
      startedAt: "2026-07-07T00:00:00.000Z",
      now: "2026-07-07T00:00:00.000Z",
    });
  });

  test("records start failure for health visibility", async () => {
    const runtime = new BackgroundWorkerRuntime({
      now: () => new Date("2026-07-07T00:00:00.000Z"),
      backgroundServiceFactory: () => ({
        boot: jest.fn(async () => {
          throw new Error("boom");
        }),
      }),
    });

    await expect(runtime.start()).rejects.toThrow("boom");
    expect(runtime.snapshot()).toMatchObject({
      status: "failed",
      lastError: "boom",
    });
  });
});
