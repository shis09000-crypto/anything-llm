const fs = require("fs");
const path = require("path");
const {
  applyCharacterStreamEvent,
  createCharacterStreamState,
  projectCharacterResponse,
  resolveCapability,
  resolveResponseCapabilities,
  validateCapabilityManifest,
  validateCharacterRequest,
  validateCharacterResponse,
} = require("../../utils/responsesRuntime/character");

const FIXTURE_ROOT = path.resolve(
  __dirname,
  "../../../docs/examples/character-responses/v1"
);

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, name), "utf8"));
}

describe("Athena Character Responses v1 contract", () => {
  const manifest = fixture("06-capability-manifest.json");

  test("accepts the two request examples", () => {
    for (const name of [
      "08-world-event-request.json",
      "09-realtime-reaction-request.json",
    ]) {
      expect(validateCharacterRequest(fixture(name))).toMatchObject({
        ok: true,
        errors: [],
      });
    }
  });

  test("accepts every final response example", () => {
    for (const name of [
      "01-language-expression-response.json",
      "02-surprise-response.json",
      "04-action-speech-response.json",
      "07-mod-action-response.json",
      "10-complete-final-response.json",
    ]) {
      const result = validateCharacterResponse(fixture(name));
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });

  test("accepts the capability manifest example", () => {
    expect(validateCapabilityManifest(manifest)).toMatchObject({
      ok: true,
      errors: [],
    });
  });

  test("rejects provider controls and UE implementation fields", () => {
    const request = fixture("08-world-event-request.json");
    request.provider = "deepseek";
    request.input[0].data.control_rig = "Face_ControlBoard_CtrlRig";
    const result = validateCharacterRequest(request);
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        "low_level_field_forbidden",
        "low_level_field_forbidden",
      ])
    );
  });

  test("requires performance_intent to be first", () => {
    const response = fixture("01-language-expression-response.json");
    response.output = [response.output[1], response.output[0], response.output[2]];
    expect(validateCharacterResponse(response).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "performance_intent_must_be_first" }),
      ])
    );
  });

  test("rejects speech emotion that conflicts with Performance Intent", () => {
    const response = fixture("01-language-expression-response.json");
    response.output[2].delivery.emotion = "athena.core:emotion/angry";
    expect(validateCharacterResponse(response).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "speech_emotion_conflict" }),
      ])
    );
  });

  test("resolves direct and manifest fallback capabilities", () => {
    expect(
      resolveCapability("athena.core:expression/amused", manifest, {
        required: true,
      })
    ).toMatchObject({
      status: "resolved",
      resolved_capability: "athena.core:expression/amused",
      fallback_depth: 0,
    });
    expect(
      resolveCapability("athena.core:expression/playful_smirk", manifest, {
        required: true,
      })
    ).toMatchObject({
      status: "resolved",
      resolved_capability: "athena.core:expression/amused",
      fallback_depth: 1,
    });
  });

  test("ignores optional unknown capability and rejects required unknown", () => {
    expect(
      resolveCapability("athena.core:gesture/not_installed", manifest)
    ).toMatchObject({ status: "ignored", resolved_capability: null });
    expect(() =>
      resolveCapability("athena.core:gesture/not_installed", manifest, {
        required: true,
      })
    ).toThrow("Required capability is unavailable");
  });

  test("detects fallback cycles", () => {
    const cyclic = structuredClone(manifest);
    cyclic.fallbacks = {
      "athena.core:gesture/cycle_a": "athena.core:gesture/cycle_b",
      "athena.core:gesture/cycle_b": "athena.core:gesture/cycle_a",
    };
    expect(() =>
      resolveCapability("athena.core:gesture/cycle_a", cyclic, {
        required: true,
      })
    ).toThrow("fallback cycle");
  });

  test("records fallback resolution and drops unavailable optional items", () => {
    const response = fixture("01-language-expression-response.json");
    response.output[1].expression =
      "athena.core:expression/playful_smirk";
    response.output.splice(2, 0, {
      ...response.output[1],
      id: "exp_optional_missing",
      required: false,
      expression: "athena.core:expression/not_installed",
    });
    const resolved = resolveResponseCapabilities(response, manifest);
    expect(resolved.output[1]).toMatchObject({
      expression: "athena.core:expression/amused",
      resolution: {
        requested_capability: "athena.core:expression/playful_smirk",
        resolved_capability: "athena.core:expression/amused",
        fallback_depth: 1,
      },
    });
    expect(
      resolved.output.some((item) => item.id === "exp_optional_missing")
    ).toBe(false);
    expect(resolved.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "optional_capability_unavailable",
          item_id: "exp_optional_missing",
        }),
      ])
    );
  });
});

describe("Athena Character Responses v1 stream reducer", () => {
  const events = fixture("05-complete-sse-events.json");

  test("reconstructs a complete response from the golden SSE stream", () => {
    const state = events.reduce(applyCharacterStreamEvent, null);
    const response = projectCharacterResponse(state);
    expect(state.status).toBe("completed");
    expect(response.output.map((item) => item.type)).toEqual([
      "performance_intent",
      "gaze",
      "speech",
    ]);
    expect(response.output[2].text).toBe("……你干嘛。");
    expect(validateCharacterResponse(response).ok).toBe(true);
  });

  test("allows gaze to finish before speech is created", () => {
    const gazeEvents = fixture("03-gaze-before-speech-events.json");
    const earlyState = gazeEvents
      .slice(0, 5)
      .reduce(applyCharacterStreamEvent, null);
    expect(earlyState.items[1]).toMatchObject({
      id: "gaze_early",
      status: "completed",
    });
    expect(earlyState.items[2]).toBeUndefined();
  });

  test("treats an identical replay as idempotent", () => {
    let state = createCharacterStreamState();
    state = applyCharacterStreamEvent(state, events[0]);
    const replayed = applyCharacterStreamEvent(state, events[0]);
    expect(replayed.last_sequence_number).toBe(0);
    expect(replayed.seen_event_ids.size).toBe(1);
  });

  test("rejects sequence gaps", () => {
    const state = applyCharacterStreamEvent(
      createCharacterStreamState(),
      events[0]
    );
    expect(() => applyCharacterStreamEvent(state, events[2])).toThrow(
      "Expected sequence_number 1"
    );
  });

  test("rejects response completion while an item is active", () => {
    const partial = events.slice(0, 3).reduce(applyCharacterStreamEvent, null);
    const terminal = { ...events.at(-1), sequence_number: 3 };
    expect(() => applyCharacterStreamEvent(partial, terminal)).toThrow(
      "while output items are active"
    );
  });

  test("rejects deltas after an item is done", () => {
    const throughIntentDone = events
      .slice(0, 4)
      .reduce(applyCharacterStreamEvent, null);
    const illegalDelta = {
      type: "character.response.output_item.delta",
      event_id: "chr_evt_illegal_delta",
      sequence_number: 4,
      created_at: 1786406440170,
      response_id: "chr_resp_full_stream",
      output_index: 0,
      item_id: "perf_full",
      revision: 2,
      delta: {
        kind: "performance_intent_patch",
        affect: {
          primary: "athena.core:emotion/neutral",
          secondary: null,
          intensity: 0.1,
          valence: 0,
          arousal: 0.1,
        },
      },
    };
    expect(() =>
      applyCharacterStreamEvent(throughIntentDone, illegalDelta)
    ).toThrow("Terminal items cannot receive deltas");
  });
});
