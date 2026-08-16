const fs = require("fs");
const path = require("path");
const {
  THREE_D_CENTER_TRACKS,
  centerDescriptor,
  centerTimeline,
  centerTurnFrame,
  characterPerformanceEndpoints,
} = require("../../endpoints/characterPerformance");

const plan = JSON.parse(
  fs.readFileSync(
    path.join(
      __dirname,
      "../../../docs/examples/character-performance/v1/01-thirteen-track-compiled-plan.json"
    ),
    "utf8"
  )
);

describe("Athena 3D Center application control plane", () => {
  test("declares an application center that consumes, but is not, a micro-module", () => {
    const descriptor = centerDescriptor();
    expect(descriptor).toMatchObject({
      id: "athena.3d-center",
      ownership: {
        kind: "application_control_center",
        micro_module: false,
        persistence: false,
      },
      wire: {
        encoding: "json",
        payload_encryption: "none",
        payload_compression: "none",
        optimization: "low_latency",
      },
      uses_micro_modules: [
        "responses-runtime",
        "chat-runtime",
        "character-performance-runtime",
      ],
    });
    expect(descriptor.domains.performance_mapping.tracks).toEqual(
      THREE_D_CENTER_TRACKS
    );
  });

  test("converts commands into ordered time blocks with fixed frontend modules", () => {
    const timeline = centerTimeline(plan);
    expect(timeline.time_blocks.length).toBeGreaterThan(1);
    for (const [index, block] of timeline.time_blocks.entries()) {
      expect(Object.keys(block.modules)).toEqual([
        "face",
        "gaze",
        "body",
        "action",
        "speech",
      ]);
      expect(block.end_ms).toBeGreaterThan(block.start_ms);
      if (index)
        expect(block.start_ms).toBeGreaterThanOrEqual(
          timeline.time_blocks[index - 1].start_ms
        );
    }
    expect(
      timeline.time_blocks.some(
        (block) =>
          Object.values(block.modules).filter((commands) => commands.length)
            .length > 1
      )
    ).toBe(true);
  });

  test("returns one center frame instead of exposing raw micro-module envelopes", () => {
    const frame = centerTurnFrame(
      {
        conversation: { id: "chr_conv_01", status: "active" },
        turn: { id: "chr_turn_01", sequence: 1 },
        response: {
          id: "chr_resp_01",
          output: [
            { id: "intent_01", type: "performance_intent" },
            { id: "sequence_01", type: "performance_sequence" },
          ],
        },
        conversation_horizon: { depth: "brief" },
        effective_handoff: { mode: "passive" },
      },
      plan
    );
    expect(frame).toMatchObject({
      object: "athena.3d_center.frame",
      protocol_version: "1.0",
      character: {
        response_id: "chr_resp_01",
        performance_intent: { type: "performance_intent" },
      },
    });
    expect(frame.timeline.time_blocks.length).toBeGreaterThan(0);
    expect(JSON.stringify(frame)).not.toMatch(
      /ciphertext|encrypted_payload|key_custody|sealed_box/i
    );
  });

  test("registers canonical 3D Center routes and legacy compatibility routes", () => {
    const routes = [];
    const app = {
      get: (route) => routes.push(route),
      post: (route) => routes.push(route),
      delete: (route) => routes.push(route),
      ws: (route) => routes.push(route),
    };
    characterPerformanceEndpoints(app);
    const flat = routes.flat();
    expect(flat).toEqual(
      expect.arrayContaining([
        "/3d-center",
        "/3d-center/sessions",
        "/3d-center/sessions/:sessionId/responses",
        "/3d-center/sessions/:sessionId/turns",
        "/3d-center/sessions/:sessionId/stream",
        "/3d-center/characters/:instanceId/memory",
        "/3d-center/characters/:instanceId/memory/sessions",
        "/3d-center/characters/:instanceId/memory/reconsolidate",
        "/character-performance/sessions",
      ])
    );
  });
});
