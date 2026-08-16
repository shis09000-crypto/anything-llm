const { PROFILE, TRACK_ORDER } =
  require("../../utils/responsesRuntime/character").v2;

function faceState(region, side, state, intensity = 0.2) {
  return {
    region,
    side,
    state: `athena.core:face_${region}/${state}`,
    intensity,
  };
}

function cueBase(id, phase, start, duration, overrides = {}) {
  return {
    cue_id: `cue_${id}`,
    phase_id: phase,
    planned_start_ms: start,
    planned_duration_ms: duration,
    easing: "blend",
    intensity: 0.4,
    amplitude: "small",
    required: false,
    ...overrides,
  };
}

function plannerPayload({
  speech = "……突然说这个干什么。",
  includeBody = true,
  includeAction = true,
  danger = false,
} = {}) {
  const emotion = danger
    ? "athena.core:emotion/afraid"
    : "athena.core:emotion/embarrassed";
  const phases = danger
    ? [
        { id: "reaction", planned_start_ms: 0, planned_duration_ms: 400 },
        { id: "orientation", planned_start_ms: 400, planned_duration_ms: 300 },
        { id: "delivery", planned_start_ms: 700, planned_duration_ms: 1700 },
        { id: "recovery", planned_start_ms: 2400, planned_duration_ms: 600 },
      ]
    : [
        { id: "reaction", planned_start_ms: 0, planned_duration_ms: 300 },
        { id: "orientation", planned_start_ms: 300, planned_duration_ms: 300 },
        { id: "delivery", planned_start_ms: 600, planned_duration_ms: 1400 },
        { id: "recovery", planned_start_ms: 2000, planned_duration_ms: 400 },
      ];
  const faceCues = [
    cueBase("face_reaction", "reaction", 0, danger ? 400 : 300, {
      required: true,
      intensity: danger ? 0.9 : 0.5,
      amplitude: danger ? "medium" : "micro",
      changes: danger
        ? [
            faceState("brow", "both", "inner_raise", 0.9),
            faceState("eyelid", "both", "wide", 0.9),
            faceState("eye_shape", "both", "wide", 0.9),
            faceState("pupil", "both", "dilate", 0.8),
            faceState("cheek", "both", "tense", 0.8),
            faceState("lip", "center", "part", 0.9),
            faceState("jaw", "center", "drop", 0.8),
          ]
        : [
            faceState("brow", "left", "single_raise", 0.45),
            faceState("eyelid", "both", "half_lidded", 0.4),
            faceState("lip", "center", "press", 0.45),
          ],
    }),
    ...(danger
      ? [
          cueBase("face_delivery", "delivery", 700, 1200, {
            intensity: 0.8,
            amplitude: "medium",
            changes: [
              faceState("brow", "both", "inner_raise", 0.8),
              faceState("lip", "center", "tremble", 0.7),
              faceState("jaw", "center", "tense", 0.7),
            ],
          }),
        ]
      : []),
    cueBase(
      "face_recovery",
      "recovery",
      danger ? 2400 : 2000,
      danger ? 600 : 400,
      {
        intensity: danger ? 0.7 : 0.25,
        amplitude: "micro",
        changes: [
          faceState(
            "brow",
            "both",
            danger ? "inner_raise" : "neutral",
            danger ? 0.7 : 0.2
          ),
          faceState(
            "eyelid",
            "both",
            danger ? "wide" : "neutral",
            danger ? 0.6 : 0.2
          ),
          faceState(
            "lip",
            "center",
            danger ? "tremble" : "neutral",
            danger ? 0.6 : 0.2
          ),
        ],
      }
    ),
  ];
  const tracks = TRACK_ORDER.map((name) => ({
    name,
    enabled: false,
    cues: [],
  }));
  tracks[0] = {
    name: "face",
    enabled: true,
    baseline: [
      faceState("brow", "both", "neutral"),
      faceState("eyelid", "both", "neutral"),
      faceState("eye_shape", "both", "neutral"),
      faceState("pupil", "both", "neutral"),
      faceState("cheek", "both", "neutral"),
      faceState("nose", "center", "neutral"),
      faceState("lip", "center", "neutral"),
      faceState("jaw", "center", "neutral"),
    ],
    cues: faceCues,
  };
  tracks[1] = {
    name: "gaze",
    enabled: true,
    cues: [
      cueBase("gaze_reaction", "reaction", 0, danger ? 400 : 300, {
        required: true,
        gaze: danger ? "athena.core:gaze/focus" : "athena.core:gaze/avert",
        target: {
          type: "semantic",
          value: danger ? "player" : "away",
        },
      }),
    ],
  };
  if (includeBody)
    tracks[2] = {
      name: "head_neck",
      enabled: true,
      cues: [
        cueBase("head_orientation", "orientation", danger ? 400 : 300, 300, {
          motion: "athena.core:head_neck_motion/turn_away",
          amplitude: "micro",
        }),
      ],
    };
  if (includeAction)
    tracks[11] = {
      name: "action",
      enabled: true,
      cues: [
        cueBase(
          "action_delivery",
          danger ? "reaction" : "delivery",
          danger ? 0 : 600,
          danger ? 300 : 600,
          {
            action: danger
              ? "athena.core:action/approach"
              : "athena.core:action/turn_to",
            target: { type: "semantic", value: "player" },
            arguments: {},
            required: danger,
          }
        ),
      ],
    };
  tracks[12] = {
    name: "speech",
    enabled: true,
    cues: [
      cueBase(
        "speech_delivery",
        danger ? "reaction" : "delivery",
        danger ? 0 : 600,
        danger ? 400 : 1400,
        {
          required: true,
          intensity: danger ? 0.9 : 0.5,
          amplitude: danger ? "medium" : "small",
          text: speech,
          language: "zh-CN",
          delivery: {
            emotion,
            emotion_source: "performance_intent",
            intensity: danger ? 0.9 : 0.5,
            rate: danger ? 1.3 : 0.9,
            volume: danger ? 0.9 : 0.6,
            style: danger
              ? "athena.core:voice_style/urgent"
              : "athena.core:voice_style/restrained",
            pause_before_ms: danger ? 0 : 200,
            pause_after_ms: 150,
          },
        }
      ),
    ],
  };
  return {
    safety_assessment: danger ? "possible_immediate_danger" : "normal",
    performance_intent: {
      affect: {
        primary: emotion,
        secondary: danger
          ? "athena.core:emotion/concerned"
          : "athena.core:emotion/tender",
        intensity: danger ? 0.9 : 0.5,
        valence: danger ? -0.8 : 0.3,
        arousal: danger ? 0.9 : 0.4,
      },
      source: danger ? "high_priority_event" : "main_agent",
      channel_modulation: {},
      transition: {
        style: danger ? "cut" : "blend",
        duration_ms: danger ? 0 : 180,
      },
      persistence: "response_lifetime",
      revision: 1,
      interruptibility: danger ? "immediate" : "blend_out",
    },
    performance_sequence: {
      planned_duration_ms: danger ? 3000 : 2400,
      phases,
      tracks,
      deliberate_stillness: !includeBody && !includeAction,
      interruptibility: danger ? "immediate" : "blend_out",
      revision: 1,
    },
  };
}

function request(text = "我爱你。") {
  return {
    protocol_version: "2.0",
    character: {
      character_id: PROFILE.characterId,
      instance_id: "char_inst_v2_test",
      capability_manifest: PROFILE.manifestRef,
    },
    conversation: {
      id: "ath_conv_v2_test",
      previous_response_id: null,
    },
    input: [
      {
        id: "input_v2_test",
        type: "user_message",
        content: [{ type: "input_text", text }],
      },
    ],
    generation: {
      mode: "main_agent",
      channels: ["performance", "face", "gaze", "body", "action", "speech"],
      latency_class: "interactive",
      performance_profile: PROFILE.id,
    },
    metadata: { test: "character_v2" },
  };
}

module.exports = { plannerPayload, request };
