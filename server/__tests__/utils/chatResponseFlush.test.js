const { writeResponseChunk } = require("../../utils/helpers/chat/responses");

jest.mock("../../utils/observability/goldenJourneys", () => ({
  markGoldenJourneyMilestone: jest.fn(),
}));

describe("chat SSE response flushing", () => {
  test("flushes each visible frame when the transport supports it", () => {
    const response = {
      write: jest.fn(),
      flush: jest.fn(),
    };

    writeResponseChunk(response, {
      type: "textResponseChunk",
      textResponse: "tail",
      close: false,
    });

    expect(response.write).toHaveBeenCalledWith(
      expect.stringContaining('"textResponse":"tail"')
    );
    expect(response.flush).toHaveBeenCalledTimes(1);
  });

  test("remains compatible with detached runtime sinks", () => {
    const response = { write: jest.fn() };
    expect(() =>
      writeResponseChunk(response, {
        type: "finalizeResponseStream",
        textResponse: "complete",
      })
    ).not.toThrow();
  });
});
