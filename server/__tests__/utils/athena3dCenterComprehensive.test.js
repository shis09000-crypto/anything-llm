const fs = require("fs");
const path = require("path");
const {
  centerDescriptor,
  centerTimeline,
} = require("../../utils/athena3dCenter");
const {
  PROFILE,
  compileCharacterV2Response,
  resolvePerformanceSequence,
} = require("../../utils/responsesRuntime/character").v2;
const {
  compilePerformancePlan,
  PerformancePackRegistry,
} = require("../../utils/characterPerformance");
const {
  initialPersistentState,
  materializePersistentStateWindow,
  STATE_SECTION_KEYS,
} = require("../../utils/responsesRuntime/character/conversation/persistentState");
const { plannerPayload, request } = require("./characterV2Fixtures");

const fixtureRoot = path.join(
  __dirname,
  "../../../docs/examples/character-responses/v2"
);

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

function responseFrom(payload) {
  const now = 1_786_500_000_000;
  return compileCharacterV2Response(
    request(),
    payload,
    providerResult(payload),
    now,
    now + 100
  );
}

describe("Athena 3D Center comprehensive deterministic gate", () => {
  test("declares a low-latency, plain-JSON application center with all 13 tracks", () => {
    const descriptor = centerDescriptor();
    expect(descriptor).toMatchObject({
      object: "athena.application_center",
      ownership: { kind: "application_control_center", micro_module: false },
      wire: {
        encoding: "json",
        payload_encryption: "none",
        payload_compression: "none",
        optimization: "low_latency",
      },
    });
    expect(descriptor.domains.performance_mapping.tracks).toHaveLength(13);
    expect(descriptor.uses_micro_modules).toEqual([
      "responses-runtime",
      "chat-runtime",
      "character-performance-runtime",
    ]);
  });

  test("compiles the full-capacity fixture into all tracks and simultaneous modules", () => {
    const response = JSON.parse(
      fs.readFileSync(
        path.join(fixtureRoot, "01-apology-demand-response.json"),
        "utf8"
      )
    );
    const resolution = resolvePerformanceSequence(response, PROFILE.manifest);
    const plan = compilePerformancePlan({
      session: { id: "chr_perf_session_full_capacity" },
      response,
      resolution: resolution.event,
      pack: new PerformancePackRegistry().load().list()[0],
      now: 1,
    });
    expect([...new Set(plan.commands.map((command) => command.track))]).toEqual(
      PROFILE.manifest.track_order
    );
    const timeline = centerTimeline(plan);
    expect(timeline.time_blocks.length).toBeGreaterThan(0);
    expect(
      timeline.time_blocks.some(
        (block) =>
          block.modules.speech.length > 0 &&
          (block.modules.face.length > 0 ||
            block.modules.gaze.length > 0 ||
            block.modules.body.length > 0 ||
            block.modules.action.length > 0)
      )
    ).toBe(true);
    expect(
      plan.commands.every(
        (command) =>
          command.timing.planned_start_ms != null &&
          command.timing.resolved_start_ms != null &&
          command.timing.actual_start_ms === null
      )
    ).toBe(true);
  });

  test("does not impose a fixed Face, Gaze, Speech order on model timing", () => {
    const payload = plannerPayload();
    payload.performance_sequence.tracks[0].cues[0].planned_start_ms = 800;
    payload.performance_sequence.tracks[0].cues[0].phase_id = "delivery";
    payload.performance_sequence.tracks[1].cues[0].planned_start_ms = 400;
    payload.performance_sequence.tracks[1].cues[0].phase_id = "orientation";
    payload.performance_sequence.tracks[12].cues[0].planned_start_ms = 0;
    payload.performance_sequence.tracks[12].cues[0].phase_id = "reaction";
    const response = responseFrom(payload);
    expect(response.output[1].tracks[12].cues[0].planned_start_ms).toBe(0);
    expect(response.output[1].tracks[1].cues[0].planned_start_ms).toBe(400);
    expect(response.output[1].tracks[0].cues[0].planned_start_ms).toBe(800);
  });

  test("first-wins keeps one impossible simultaneous gaze and records suppression", () => {
    const payload = plannerPayload();
    payload.performance_sequence.tracks[1].cues.push({
      ...payload.performance_sequence.tracks[1].cues[0],
      cue_id: "cue_gaze_conflicting_target",
      gaze: "athena.core:gaze/focus",
      target: { type: "semantic", value: "door" },
      planned_start_ms: 100,
      planned_duration_ms: 100,
    });
    const resolution = resolvePerformanceSequence(
      responseFrom(payload),
      PROFILE.manifest
    );
    expect(resolution.suppressedCues).toEqual([
      expect.objectContaining({
        cue_id: "cue_gaze_conflicting_target",
        track: "gaze",
        policy: "first_wins",
      }),
    ]);
    expect(resolution.resolvedCues.filter((cue) => cue.track === "gaze")).toHaveLength(
      1
    );
  });

  test("materializes a complete three-state window and explicitly marks unchanged blocks", () => {
    const previous = initialPersistentState({
      revision: 4,
      updated_at: 1_786_500_000_000,
    });
    const next = structuredClone(previous);
    next.face = next.face.map((entry) =>
      entry.region === "lip"
        ? { ...entry, state: "athena.core:face_lip/press", intensity: 0.35 }
        : entry
    );
    const window = materializePersistentStateWindow({
      previousState: previous,
      transition: {
        from_revision: 4,
        style: "blend",
        duration_ms: 400,
        next_state: next,
      },
      turnId: "turn_05",
      responseId: "chr_resp_05",
      sequenceId: "sequence_05",
      now: 1_786_500_000_400,
    });
    expect(window.current_state.revision).toBe(5);
    expect(Object.keys(window.transition.changes)).toEqual(STATE_SECTION_KEYS);
    expect(window.transition.changes.face.changed).toBe(true);
    expect(window.transition.changes.gaze.changed).toBe(false);
    expect(window.transition.changes.left_hand.changed).toBe(false);
    expect(window.current_state.face).toHaveLength(8);
  });
});
