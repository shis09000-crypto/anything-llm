const path = require("path");
const vectors = require(path.resolve(
  __dirname,
  "../../../docs/sync-v2-canonical-json-vectors.json"
));
const {
  canonicalJson,
  contentHash,
} = require("../../utils/syncV2/canonicalJson");

describe("Sync V2 canonical JSON", () => {
  test.each(vectors)("$name", (vector) => {
    expect(canonicalJson(vector.input)).toBe(vector.canonical);
    expect(contentHash(vector.input)).toBe(vector.hash);
  });

  test("Date values use RFC3339 milliseconds", () => {
    expect(canonicalJson({ when: new Date("2026-07-17T12:34:56.789Z") })).toBe(
      '{"when":"2026-07-17T12:34:56.789Z"}'
    );
  });
});
