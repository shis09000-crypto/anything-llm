/* eslint-env jest */

const {
  fingerprint,
  getSchema,
  schemaManifest,
  validateRegistered,
} = require("../../utils/operations/schemaRegistry");
const { semanticEvent } = require("../../utils/observability/semanticEvents");

describe("Operations Schema Registry", () => {
  test("publishes an immutable Semantic Event v1 fingerprint", () => {
    const entry = getSchema("athena.ops.event", "1.0");
    expect(entry).not.toBeNull();
    expect(entry.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint(entry.schema)).toBe(entry.fingerprint);
    expect(schemaManifest()).toContainEqual({
      name: "athena.ops.event",
      version: "1.0",
      fingerprint: entry.fingerprint,
    });
  });

  test("accepts registered events and rejects unknown versions", () => {
    const event = semanticEvent({
      eventType: "chat.completed",
      category: "chat",
      severity: "info",
    });
    expect(validateRegistered(event)).toEqual({ valid: true, errors: [] });
    expect(validateRegistered({ ...event, schemaVersion: "2.0" })).toEqual(
      expect.objectContaining({
        valid: false,
        errors: ["unknown_schema:athena.ops.event@2.0"],
      })
    );
  });

  test("rejects undeclared or sensitive payload fields", () => {
    const event = semanticEvent({
      eventType: "chat.completed",
      category: "chat",
      metadata: { durationMs: 40 },
    });

    expect(
      validateRegistered({ ...event, prompt: "must not persist" })
    ).toEqual(
      expect.objectContaining({ valid: false, errors: ["unknown:prompt"] })
    );
    expect(
      validateRegistered({
        ...event,
        metadata: { ...event.metadata, requestBody: "must not persist" },
      })
    ).toEqual(
      expect.objectContaining({
        valid: false,
        errors: ["unknown:metadata.requestBody"],
      })
    );
  });
});
