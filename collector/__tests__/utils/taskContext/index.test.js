const {
  isCollectorProcessingRoute,
} = require("../../../utils/taskContext");

describe("collector task route policy", () => {
  test.each([
    "/process",
    "/parse",
    "/process-link",
    "/util/get-link",
    "/process-raw-text",
    "/ext/website-depth",
    "/ext/github-repo",
  ])("places processing route %s behind the task guard", (route) => {
    expect(isCollectorProcessingRoute({ method: "POST", path: route })).toBe(
      true
    );
  });

  test.each(["/health", "/accepts", "/metrics"])(
    "does not queue control route %s",
    (route) => {
      expect(isCollectorProcessingRoute({ method: "GET", path: route })).toBe(
        false
      );
    }
  );
});
