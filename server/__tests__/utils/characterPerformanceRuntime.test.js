const fs = require("fs");
const path = require("path");
const {
  CharacterPerformanceRuntime,
  PerformancePackRegistry,
  compilePerformancePlan,
  validatePack,
} = require("../../utils/characterPerformance");
const { PROFILE, resolvePerformanceSequence } =
  require("../../utils/responsesRuntime/character").v2;

const fixtureRoot = path.join(
  __dirname,
  "../../../docs/examples/character-responses/v2"
);

function compiledFixture() {
  const response = JSON.parse(
    fs.readFileSync(
      path.join(fixtureRoot, "01-apology-demand-response.json"),
      "utf8"
    )
  );
  const resolution = resolvePerformanceSequence(response, PROFILE.manifest);
  const pack = new PerformancePackRegistry().load().list()[0];
  return compilePerformancePlan({
    session: { id: "chr_perf_session_01" },
    response,
    resolution: resolution.event,
    pack,
    now: 1,
  });
}

describe("Athena Performance Mapping Center", () => {
  test("loads a digest-pinned, engine-neutral 13-track Pack", () => {
    const pack = new PerformancePackRegistry().load().list()[0];
    expect(validatePack(pack)).toMatchObject({ ok: true });
    expect(pack.track_support.map((entry) => entry.track)).toEqual(
      PROFILE.manifest.track_order
    );
    expect(pack.asset.asset_ref).toMatch(/^builtin:/);
    expect(JSON.stringify(pack)).not.toMatch(
      /https?:\/\/|animation_montage|morph_target|control_rig|skeleton/i
    );
  });

  test("compiles resolved cues into commands for all 13 tracks", () => {
    const plan = compiledFixture();
    expect([...new Set(plan.commands.map((command) => command.track))]).toEqual(
      PROFILE.manifest.track_order
    );
    expect(plan.commands.length).toBeGreaterThan(13);
    expect(plan.commands[0]).toMatchObject({
      primitive: "face.region_state",
      timing: {
        planned_start_ms: expect.any(Number),
        resolved_start_ms: expect.any(Number),
        actual_start_ms: null,
      },
    });
    expect(
      plan.commands.some((command) => command.primitive === "speech.text")
    ).toBe(true);
    expect(
      plan.commands.some((command) => command.primitive === "world.action")
    ).toBe(true);
  });

  test("preserves cross-track simultaneity in the compiled plan", () => {
    const plan = compiledFixture();
    const starts = new Map();
    for (const command of plan.commands) {
      const tracks = starts.get(command.start_ms) || new Set();
      tracks.add(command.track);
      starts.set(command.start_ms, tracks);
    }
    expect([...starts.values()].some((tracks) => tracks.size > 1)).toBe(true);
  });

  test("rejects a Character response pinned to a different Manifest", () => {
    const response = JSON.parse(
      fs.readFileSync(
        path.join(fixtureRoot, "01-apology-demand-response.json"),
        "utf8"
      )
    );
    const resolution = resolvePerformanceSequence(response, PROFILE.manifest);
    response.capability_manifest.sha256 = "0".repeat(64);
    expect(() =>
      compilePerformancePlan({
        session: { id: "chr_perf_session_01" },
        response,
        resolution: resolution.event,
        pack: new PerformancePackRegistry().load().list()[0],
      })
    ).toThrow(
      expect.objectContaining({ code: "performance_plan_manifest_mismatch" })
    );
  });

  test("accepts idempotent feedback and rejects forged command IDs", async () => {
    const plan = compiledFixture();
    const feedback = new Map();
    const events = [];
    const repository = {
      findSession: jest.fn(async () => ({
        id: "chr_perf_session_01",
        workspaceId: 1,
        threadId: null,
        ownerUserId: null,
      })),
      findPlan: jest.fn(async () => ({
        id: plan.id,
        sessionId: plan.session_id,
      })),
      latestPlan: jest.fn(async () => ({
        id: plan.id,
        sessionId: plan.session_id,
      })),
      readPlan: jest.fn(async () => plan),
      findFeedback: jest.fn(async (id) => feedback.get(id) || null),
      saveFeedback: jest.fn(async (sessionId, _planId, event) => {
        feedback.set(event.event_id, { id: event.event_id, sessionId });
      }),
      appendEvent: jest.fn(async (event) => events.push(event)),
    };
    const runtime = new CharacterPerformanceRuntime({ repository });
    const body = {
      plan_id: plan.id,
      scope: { workspace_id: 1 },
      events: [
        {
          event_id: "feedback_01",
          command_id: plan.commands[0].command_id,
          status: "started",
          actual_start_ms: 91,
        },
      ],
    };
    await expect(
      runtime.feedback(plan.session_id, {
        ...body,
        events: [
          {
            event_id: "feedback_00",
            command_id: plan.commands[0].command_id,
            status: "completed",
            actual_start_ms: 91,
            actual_duration_ms: 420,
          },
        ],
      })
    ).rejects.toMatchObject({
      code: "performance_feedback_transition_invalid",
    });
    await expect(runtime.feedback(plan.session_id, body)).resolves.toEqual({
      accepted: [{ event_id: "feedback_01", duplicate: false }],
    });
    await expect(runtime.feedback(plan.session_id, body)).resolves.toEqual({
      accepted: [{ event_id: "feedback_01", duplicate: true }],
    });
    await expect(
      runtime.feedback(plan.session_id, {
        ...body,
        events: [
          { event_id: "feedback_02", command_id: "forged", status: "failed" },
        ],
      })
    ).rejects.toMatchObject({ code: "performance_feedback_command_forged" });
    expect(events).toHaveLength(1);
  });
});
