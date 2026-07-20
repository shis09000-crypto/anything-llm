const { LIMITS, limitFor } = require("../../middleware/requestBodyPolicy");

describe("collector request body policy", () => {
  it("limits control requests to one MiB", () => {
    expect(limitFor({ path: "/process" })).toEqual({
      ...LIMITS.control,
      limitClass: "collector_control",
    });
  });

  it("limits raw text requests to 32 MiB", () => {
    expect(limitFor({ path: "/process-raw-text" })).toEqual({
      ...LIMITS.rawText,
      limitClass: "collector_raw_text",
    });
  });
});
