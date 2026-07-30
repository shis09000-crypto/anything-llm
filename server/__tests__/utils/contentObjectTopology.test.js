/* eslint-env jest */

const { contentStoreProvider } = require("../../utils/contentObjects/policy");

describe("content object topology policy", () => {
  test("keeps local storage available for desktop mode", () => {
    expect(contentStoreProvider({ ATHENA_RUNTIME_TOPOLOGY: "desktop" })).toBe(
      "local"
    );
  });

  test("requires S3-compatible storage in cloud and distributed modes", () => {
    expect(() =>
      contentStoreProvider({ ATHENA_RUNTIME_TOPOLOGY: "distributed" })
    ).toThrow("distributed_runtime_requires_object_storage");
    expect(
      contentStoreProvider({
        ATHENA_RUNTIME_TOPOLOGY: "cloud",
        ATHENA_CONTENT_STORE: "s3",
      })
    ).toBe("s3");
  });
});
