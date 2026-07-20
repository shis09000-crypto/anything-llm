const {
  authoritativeChangedPaths,
  mutationReceiptId,
  mutationRequestHash,
  validateProjectedPayload,
} = require("../../utils/syncV2/mutationPolicy");

describe("Sync V2 mutation policy", () => {
  it("derives authoritative nested merge paths without client metadata", () => {
    expect(
      authoritativeChangedPaths({
        operation: "merge",
        changedPaths: ["untrusted"],
        payload: {
          theme: { mode: "dark", contrast: null },
          dirty: true,
          updatedAt: "client-clock",
        },
      })
    ).toEqual(["theme.mode", "theme.contrast"]);
  });

  it("uses the root path for destructive and set operations", () => {
    for (const operation of ["replace", "delete", "set-add", "set-remove"]) {
      expect(authoritativeChangedPaths({ operation, payload: {} })).toEqual([
        "$",
      ]);
    }
  });

  it("accepts only fields represented by workspace metadata projection", () => {
    expect(
      validateProjectedPayload("workspace-metadata", {
        name: "Research",
        chatModel: "model",
      })
    ).toMatchObject({ fields: ["name", "chatModel"] });
    expect(
      validateProjectedPayload("workspace-metadata", {
        openAiPrompt: "not projected",
      })
    ).toMatchObject({
      error: "sync_v2_unsupported_fields",
      unsupported: ["openAiPrompt"],
    });
  });

  it("rejects non-object and empty projected mutations", () => {
    expect(validateProjectedPayload("thread-metadata", null).error).toBe(
      "sync_v2_object_payload_required"
    );
    expect(validateProjectedPayload("user-profile", {}).error).toBe(
      "sync_v2_empty_mutation"
    );
  });

  it("binds an idempotency receipt to semantic request content", () => {
    const mutation = {
      mutationId: "client-intent",
      nodeKey: "threads/3/metadata",
      baseVersion: 4,
      operation: "merge",
      changedPaths: ["untrusted"],
      payload: { name: "A" },
    };
    expect(mutationRequestHash(mutation)).toBe(
      mutationRequestHash({ ...mutation, changedPaths: ["different-hint"] })
    );
    expect(mutationRequestHash(mutation)).not.toBe(
      mutationRequestHash({ ...mutation, payload: { name: "B" } })
    );
    expect(mutationReceiptId("client-intent")).toMatch(
      /^sync-v2:[a-f0-9]{64}$/
    );
  });
});
