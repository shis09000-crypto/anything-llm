const {
  CognitionWorkerLifecycle,
} = require("../../utils/workspaceCognition/workerLifecycle");

describe("CognitionWorkerLifecycle", () => {
  afterEach(() => jest.useRealTimers());

  it("clears bootstrap and interval work before shutdown completes", async () => {
    jest.useFakeTimers();
    const tick = jest.fn(async () => {});
    const scanSilence = jest.fn(async () => {});
    const lifecycle = new CognitionWorkerLifecycle({
      recover: async () => {},
      tick,
      scanSilence,
      isBusy: () => false,
    });

    expect(lifecycle.start()).toBe(true);
    expect(lifecycle.start()).toBe(false);
    await Promise.resolve();
    await lifecycle.stop({ timeoutMs: 100 });
    jest.advanceTimersByTime(120_000);

    expect(tick).not.toHaveBeenCalled();
    expect(scanSilence).not.toHaveBeenCalled();
  });
});
