const { storedIdempotencyKey } = require("../../models/scheduledJobRun");
const { RemoteSchedulerControl } = require("../../utils/scheduler/control");
const { SchedulerRuntime } = require("../../utils/scheduler/runtime");

describe("SchedulerRuntime", () => {
  test("owns only scheduled execution and supports idempotent triggers", async () => {
    const service = {
      mode: "scheduler",
      boot: jest.fn(async () => {}),
      jobs: jest.fn(() => []),
      reconcileScheduledJobs: jest.fn(async () => ({
        enabled: 1,
        registered: 1,
      })),
      syncScheduledJob: jest.fn(async () => {}),
      removeScheduledJob: jest.fn(),
      enqueueScheduledJob: jest.fn(async (_jobId, options) => ({
        id: 11,
        jobId: 7,
        status: "queued",
        receivedKey: options.idempotencyKey,
      })),
      killRun: jest.fn(() => true),
      stop: jest.fn(async () => {}),
    };
    const runtime = new SchedulerRuntime({
      serviceFactory: () => service,
      reconcileIntervalMs: 60_000,
    });

    expect(await runtime.start()).toMatchObject({
      ready: true,
      mode: "scheduler",
    });
    await expect(
      runtime.triggerJob(7, { idempotencyKey: "stable-request" })
    ).resolves.toMatchObject({
      triggered: true,
      run: { id: 11, jobId: 7, status: "queued" },
    });
    expect(service.enqueueScheduledJob).toHaveBeenCalledWith(7, {
      idempotencyKey: "stable-request",
    });
    await runtime.stop();
    expect(service.stop).toHaveBeenCalledTimes(1);
  });

  test("hashes scheduler idempotency keys with the job scope", () => {
    const left = storedIdempotencyKey(7, "same-request");
    const right = storedIdempotencyKey(8, "same-request");
    expect(left).toMatch(/^[a-f0-9]{64}$/);
    expect(left).not.toBe(right);
    expect(storedIdempotencyKey(7, "")).toBeNull();
  });

  test("remote scheduler control refuses non-mTLS distributed endpoints", async () => {
    const control = new RemoteSchedulerControl({
      env: {
        NODE_ENV: "production",
        ATHENA_RUNTIME_TOPOLOGY: "distributed",
        ATHENA_SCHEDULER_INTERNAL_URL: "http://scheduler:3014",
      },
    });
    await expect(control.syncScheduledJob(7)).rejects.toMatchObject({
      code: "INTERNAL_SERVICE_TLS_REQUIRED",
    });
  });
});
