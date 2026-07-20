const { readRequestHeader } = require("../../utils/http/requestHeaders");

describe("readRequestHeader", () => {
  it("supports Express and request-like callers without requiring header()", () => {
    expect(
      readRequestHeader({ header: (name) => `express:${name}` }, "X-Test")
    ).toBe("express:X-Test");
    expect(readRequestHeader({ headers: { "x-test": "raw" } }, "X-Test")).toBe(
      "raw"
    );
    expect(readRequestHeader({ headers: {} }, "X-Test")).toBeUndefined();
  });
});
