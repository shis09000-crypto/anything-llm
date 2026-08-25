const {
  DEFAULT_FLASH_VISION_MODEL,
  resolveResponsesModel,
} = require("../../utils/responsesRuntime/modelRouting");
const { requestBody } = require("../../utils/responsesRuntime/chatAdapter");

describe("Responses Flash Vision model routing", () => {
  test("maps the public Flash selection to the configured Vision model", () => {
    expect(
      resolveResponsesModel({
        provider: "deepseek",
        requestedModel: "deepseek-v4-flash",
        env: { DEEPSEEK_FLASH_VISION_MODEL: "vision-live" },
      })
    ).toEqual({
      provider: "deepseek",
      requestedModel: "deepseek-v4-flash",
      effectiveModel: "vision-live",
      flashVision: true,
    });
  });

  test("uses the stable Vision default and leaves Pro unchanged", () => {
    expect(
      resolveResponsesModel({
        provider: "deepseek",
        requestedModel: "deepseek-v4-flash",
        env: {},
      }).effectiveModel
    ).toBe(DEFAULT_FLASH_VISION_MODEL);
    expect(
      resolveResponsesModel({
        provider: "deepseek",
        requestedModel: "deepseek-v4-pro",
        env: { DEEPSEEK_FLASH_VISION_MODEL: "vision-live" },
      }).effectiveModel
    ).toBe("deepseek-v4-pro");
  });

  test("quiz and dedicated Responses request bodies share the resolver", () => {
    const body = requestBody(
      [{ role: "user", content: "question" }],
      { env: { DEEPSEEK_FLASH_VISION_MODEL: "vision-quiz" } },
      { taskName: "quiz_generation" },
      { provider: "deepseek", model: "deepseek-v4-flash" }
    );
    expect(body.model).toBe("vision-quiz");
    expect(body.athena).toMatchObject({
      requestedModel: "deepseek-v4-flash",
      effectiveModel: "vision-quiz",
    });
  });
});
