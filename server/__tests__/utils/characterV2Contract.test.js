const fs = require("fs");
const path = require("path");
const {
  FlashCharacterV2Adapter,
  MockPerformanceClient,
  PROFILE,
  applyCharacterV2Event,
  compileCharacterPresentation,
  compileCharacterV2Response,
  emptyCharacterV2State,
  normalizedCharacterV2Sequence,
  resolvePerformanceSequence,
  validateCharacterV2Request,
  validateCharacterV2Response,
} = require("../../utils/responsesRuntime/character").v2;
const { plannerPayload, request } = require("./characterV2Fixtures");

function providerResult(payload) {
  return {
    output: [
      {
        type: "function_call",
        name: "emit_character_performance_v2",
        arguments: JSON.stringify(payload),
      },
    ],
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    effectiveProtocol: "mock_function_call",
  };
}

describe("Athena Character Responses v2", () => {
  test("accepts the provider-neutral v2 request", () => {
    const value = request();
    expect(validateCharacterV2Request(value).ok).toBe(true);
    expect(value).not.toHaveProperty("provider");
  });

  test("compiles exactly Performance Intent then Performance Sequence", () => {
    const now = Date.now();
    const response = compileCharacterV2Response(
      request(),
      plannerPayload(),
      providerResult(plannerPayload()),
      now,
      now + 100
    );
    expect(response.output.map((item) => item.type)).toEqual([
      "performance_intent",
      "performance_sequence",
    ]);
    expect(validateCharacterV2Response(response)).toMatchObject({ ok: true });
    expect(response.presentation).toMatchObject({
      schema: "athena.character.presentation",
      version: "1.0",
      planned: { duration_ms: expect.any(Number) },
      resolved: null,
    });
    expect(
      response.presentation.planned.time_blocks.every(
        (block) =>
          Object.keys(block.modules).join(",") ===
          PROFILE.manifest.track_order.join(",")
      )
    ).toBe(true);
  });

  test("serializes keyed model tracks without changing cue timing or values", () => {
    const now = Date.now();
    const payload = plannerPayload();
    const originalTracks = payload.performance_sequence.tracks;
    payload.performance_sequence.tracks = Object.fromEntries(
      originalTracks.map(({ name, ...track }) => [name, track])
    );
    const response = compileCharacterV2Response(
      request(),
      payload,
      providerResult(payload),
      now,
      now + 100
    );
    expect(response.output[1].tracks.map((track) => track.name)).toEqual(
      PROFILE.manifest.track_order
    );
    expect(response.output[1].tracks[12].cues).toEqual(originalTracks[12].cues);
  });

  test("allows Speech and Action in the same time block", () => {
    const now = Date.now();
    const payload = plannerPayload({ includeAction: true });
    const response = compileCharacterV2Response(
      request(),
      payload,
      providerResult(payload),
      now,
      now + 100
    );
    const tracks = response.output[1].tracks;
    expect(tracks[11].cues[0].planned_start_ms).toBe(600);
    expect(tracks[12].cues[0].planned_start_ms).toBe(600);
    expect(validateCharacterV2Response(response).ok).toBe(true);
    const simultaneous = response.presentation.planned.time_blocks.find(
      (block) => block.start_ms === 600
    );
    expect(simultaneous.modules.action.state).toBe("active");
    expect(simultaneous.modules.speech.state).toBe("active");
  });

  test("allows the model to keep all body and action tracks still", () => {
    const now = Date.now();
    const payload = plannerPayload({
      includeBody: false,
      includeAction: false,
    });
    const response = compileCharacterV2Response(
      request(),
      payload,
      providerResult(payload),
      now,
      now + 100
    );
    expect(
      response.output[1].tracks.slice(2, 12).every((track) => !track.enabled)
    ).toBe(true);
    expect(validateCharacterV2Response(response).ok).toBe(true);
  });

  test("rejects missing facial baseline regions", () => {
    const now = Date.now();
    const payload = plannerPayload();
    payload.performance_sequence.tracks[0].baseline.pop();
    const response = compileCharacterV2Response(
      request(),
      payload,
      providerResult(payload),
      now,
      now + 100
    );
    expect(validateCharacterV2Response(response).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "face_baseline_incomplete" }),
      ])
    );
  });

  test("conservatively suppresses the later cue on an exclusive-track conflict", () => {
    const now = Date.now();
    const payload = plannerPayload();
    payload.performance_sequence.tracks[2].cues.push({
      ...payload.performance_sequence.tracks[2].cues[0],
      cue_id: "cue_head_overlap",
      planned_start_ms: 400,
      planned_duration_ms: 100,
    });
    const response = compileCharacterV2Response(
      request(),
      payload,
      providerResult(payload),
      now,
      now + 100
    );
    expect(validateCharacterV2Response(response).ok).toBe(true);
    const resolution = resolvePerformanceSequence(response, PROFILE.manifest);
    expect(resolution.resolvedCues.map((cue) => cue.cue_id)).not.toContain(
      "cue_head_overlap"
    );
    expect(resolution.suppressedCues).toEqual([
      expect.objectContaining({
        cue_id: "cue_head_overlap",
        track: "head_neck",
        policy: "first_wins",
      }),
    ]);
    expect(resolution.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "cue_conflict_suppressed" }),
      ])
    );
    const presentation = compileCharacterPresentation(response, resolution);
    expect(
      presentation.planned.time_blocks.some((block) =>
        block.modules.head_neck.active.some(
          (entry) => entry.cue_id === "cue_head_overlap"
        )
      )
    ).toBe(true);
    expect(
      presentation.resolved.time_blocks.some((block) =>
        block.modules.head_neck.active.some(
          (entry) => entry.cue_id === "cue_head_overlap"
        )
      )
    ).toBe(false);
  });

  test("resolves planned timing and records actual timing separately", () => {
    const now = Date.now();
    const payload = plannerPayload();
    const response = compileCharacterV2Response(
      request(),
      payload,
      providerResult(payload),
      now,
      now + 100
    );
    const resolution = resolvePerformanceSequence(response, PROFILE.manifest);
    const execution = new MockPerformanceClient({ now: () => now }).execute(
      response,
      resolution
    );
    expect(resolution.resolvedCues[0]).toEqual(
      expect.objectContaining({
        planned_duration_ms: expect.any(Number),
        resolved_duration_ms: expect.any(Number),
      })
    );
    expect(execution.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "character.execution.completed",
          actual_duration_ms: expect.any(Number),
        }),
      ])
    );
  });

  test("reduces typed sequence events and ignores duplicates", () => {
    const event = {
      type: "character.performance.sequence.phase.added",
      event_id: "chr_evt_test",
      sequence_number: 1,
      created_at: Date.now(),
      response_id: "chr_resp_test",
      phase: {
        id: "reaction",
        planned_start_ms: 0,
        planned_duration_ms: 300,
      },
    };
    const once = applyCharacterV2Event(emptyCharacterV2State(), event);
    const twice = applyCharacterV2Event(once, event);
    expect(twice.phases.size).toBe(1);
  });

  test("reconstructs the final sequence from the complete SSE fixture", () => {
    const fixtureRoot = path.join(
      __dirname,
      "../../../docs/examples/character-responses/v2"
    );
    const events = JSON.parse(
      fs.readFileSync(
        path.join(fixtureRoot, "07-complete-sse-events.json"),
        "utf8"
      )
    );
    const response = JSON.parse(
      fs.readFileSync(
        path.join(fixtureRoot, "04-love-confession-response.json"),
        "utf8"
      )
    );
    const state = events.reduce(applyCharacterV2Event, undefined);
    expect(state.terminal).toBe(true);
    expect(normalizedCharacterV2Sequence(state)).toEqual(response.output[1]);
  });

  test("rejects a manifest whose canonical digest was changed", () => {
    const now = Date.now();
    const payload = plannerPayload();
    const response = compileCharacterV2Response(
      request(),
      payload,
      providerResult(payload),
      now,
      now + 100
    );
    const changedManifest = {
      ...PROFILE.manifest,
      performance_profile: "athena.changed.profile",
    };
    expect(() => resolvePerformanceSequence(response, changedManifest)).toThrow(
      expect.objectContaining({ code: "character_v2_manifest_digest_invalid" })
    );
  });

  test("rejects Action arguments outside the Manifest parameter schema", () => {
    const now = Date.now();
    const payload = plannerPayload();
    payload.performance_sequence.tracks[11].cues[0].arguments = {
      unsupported_semantic: "not_declared",
    };
    const response = compileCharacterV2Response(
      request(),
      payload,
      providerResult(payload),
      now,
      now + 100
    );
    expect(() =>
      resolvePerformanceSequence(response, PROFILE.manifest)
    ).toThrow(
      expect.objectContaining({ code: "character_v2_action_arguments_invalid" })
    );
  });

  test("forces every Flash v2 generation through JSON Output without repairing payload", async () => {
    const payload = plannerPayload();
    const complete = jest.fn().mockResolvedValue({
      output_text: JSON.stringify(payload),
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      effectiveProtocol: "responses",
    });
    const generated = await new FlashCharacterV2Adapter({
      modelClient: { complete },
    }).generate(request());
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "deepseek",
        model: "deepseek-v4-flash",
        responseFormat: { type: "json_object" },
        maxOutputTokens: 32768,
      })
    );
    expect(complete.mock.calls[0][0]).not.toHaveProperty("tools");
    expect(complete.mock.calls[0][0]).not.toHaveProperty("toolChoice");
    expect(generated.responseValidation.ok).toBe(true);
  });

  test("rejects ordinary text protocol even when its content happens to be JSON", async () => {
    const complete = jest.fn().mockResolvedValue({
      output_text: JSON.stringify(plannerPayload()),
      effectiveProtocol: "chat_completions",
    });
    await expect(
      new FlashCharacterV2Adapter({ modelClient: { complete } }).generate(
        request()
      )
    ).rejects.toMatchObject({
      code: "character_v2_json_output_protocol_required",
    });
  });
});
