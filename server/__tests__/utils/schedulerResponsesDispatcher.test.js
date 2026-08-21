jest.mock("../../utils/microModules/internalClient", () => ({
  requestInternalService: jest.fn(),
}));

const {
  requestInternalService,
} = require("../../utils/microModules/internalClient");
const { SchedulerRuntime } = require("../../utils/scheduler/runtime");

describe("Scheduler Responses dispatcher", () => {
  test("clears a stale dispatch error after an empty claim succeeds", async () => {
    requestInternalService.mockResolvedValueOnce({
      success: true,
      response: null,
    });
    const previousUrl = process.env.ATHENA_RESPONSES_RUNTIME_URL;
    process.env.ATHENA_RESPONSES_RUNTIME_URL = "http://responses-runtime.test";
    const runtime = new SchedulerRuntime();
    runtime.status = "running";
    runtime.lastError = "AICP_RESULT_CONTEXT_MISSING";

    try {
      runtime.startResponsesDispatcher();
      for (
        let attempt = 0;
        attempt < 10 && runtime.responsesTaskActive;
        attempt += 1
      )
        await new Promise((resolve) => setImmediate(resolve));

      expect(requestInternalService).toHaveBeenCalledWith(
        expect.objectContaining({
          capability: "responses.background.claim",
        })
      );
      expect(runtime.lastError).toBeNull();
    } finally {
      await runtime.stop();
      if (previousUrl === undefined)
        delete process.env.ATHENA_RESPONSES_RUNTIME_URL;
      else process.env.ATHENA_RESPONSES_RUNTIME_URL = previousUrl;
    }
  });
});
