const mockRequestInternalService = jest.fn();

jest.mock("../../utils/microModules", () => ({
  requestInternalService: (...args) => mockRequestInternalService(...args),
}));

const {
  enrichChatExecutionMetadata,
} = require("../../utils/responsesRuntime/executionMetadataClient");

describe("Responses execution metadata history enrichment", () => {
  const originalUrl = process.env.ATHENA_RESPONSES_RUNTIME_URL;

  beforeEach(() => {
    mockRequestInternalService.mockReset();
    process.env.ATHENA_RESPONSES_RUNTIME_URL = "http://responses-runtime.test";
  });

  afterAll(() => {
    if (originalUrl === undefined)
      delete process.env.ATHENA_RESPONSES_RUNTIME_URL;
    else process.env.ATHENA_RESPONSES_RUNTIME_URL = originalUrl;
  });

  test("keeps a trustworthy legacy metrics model without a runtime lookup", async () => {
    const record = {
      clientTurnId: "legacy-run",
      response: JSON.stringify({
        text: "legacy",
        metrics: { model: "deepseek-v4-pro" },
      }),
    };

    await expect(enrichChatExecutionMetadata([record])).resolves.toEqual([
      record,
    ]);
    expect(mockRequestInternalService).not.toHaveBeenCalled();
  });

  test("batch backfills a Responses model using the chat run reference", async () => {
    mockRequestInternalService.mockResolvedValue({
      items: [
        {
          id: "ath_resp_1",
          chatRunId: "flash-run",
          model: "deepseek-v4-flash",
          provider: "deepseek",
          requestedProtocol: "responses",
          effectiveProtocol: "responses",
        },
      ],
    });
    const [record] = await enrichChatExecutionMetadata(
      [
        {
          clientTurnId: "flash-run",
          response: JSON.stringify({ text: "flash" }),
        },
      ],
      { userId: 1, workspaceId: 2, threadId: 3 }
    );

    expect(JSON.parse(record.response).execution).toEqual(
      expect.objectContaining({
        model: "deepseek-v4-flash",
        responseId: "ath_resp_1",
        source: "responses_runtime",
      })
    );
    expect(mockRequestInternalService).toHaveBeenCalledTimes(1);
  });

  test("preserves history and marks the model unknown when runtime evidence is unavailable", async () => {
    mockRequestInternalService.mockRejectedValue(
      new Error("runtime unavailable")
    );
    const [record] = await enrichChatExecutionMetadata([
      {
        clientTurnId: "old-run",
        response: JSON.stringify({ text: "still readable" }),
      },
    ]);
    const response = JSON.parse(record.response);

    expect(response.text).toBe("still readable");
    expect(response.execution).toEqual(
      expect.objectContaining({ model: null, source: "unknown" })
    );
  });
});
