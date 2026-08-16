const crypto = require("crypto");
const {
  FACE_REGIONS,
  MANIFEST_OBJECT,
  PERFORMANCE_PROFILE,
  PROTOCOL_VERSION,
} = require("./constants");

const CAPABILITIES = Object.freeze({
  emotions: Object.freeze(
    [
      "neutral",
      "annoyed",
      "concerned",
      "amused",
      "happy",
      "surprised",
      "embarrassed",
      "sad",
      "afraid",
      "determined",
      "tender",
      "angry",
    ].map((name) => `athena.core:emotion/${name}`)
  ),
  face: Object.freeze({
    brow: ["neutral", "lowered", "inner_raise", "outer_raise", "single_raise"],
    eyelid: ["neutral", "narrowed", "wide", "half_lidded", "blink", "lowered"],
    eye_shape: ["neutral", "soft", "sharp", "wide", "squint"],
    pupil: ["neutral", "contract", "dilate"],
    cheek: ["neutral", "lift", "tense", "flush"],
    nose: ["neutral", "slight_wrinkle", "flare"],
    lip: [
      "neutral",
      "press",
      "corner_up",
      "corner_down",
      "part",
      "restrained_smile",
      "tremble",
    ],
    jaw: ["neutral", "set", "drop", "tense", "quiver"],
  }),
  gaze: Object.freeze([
    "athena.core:gaze/direct",
    "athena.core:gaze/avert",
    "athena.core:gaze/glance",
    "athena.core:gaze/focus",
    "athena.core:gaze/follow",
  ]),
  motion: Object.freeze({
    head_neck: [
      "still",
      "turn_toward",
      "turn_away",
      "tilt",
      "lower",
      "raise",
      "freeze",
    ],
    shoulders: [
      "relax",
      "tense",
      "raise",
      "drop_left",
      "drop_right",
      "draw_in",
    ],
    torso: [
      "upright",
      "lean_forward",
      "lean_back",
      "turn_toward",
      "turn_away",
      "curl_in",
      "freeze",
    ],
    arm: [
      "rest",
      "cross",
      "extend",
      "withdraw",
      "hold_close",
      "dismissive_sweep",
      "reach",
    ],
    hand: [
      "relaxed",
      "open_palm",
      "fist",
      "point",
      "pinch_clothing",
      "cover_mouth",
      "touch_chest",
      "reach",
    ],
    leg: [
      "balanced",
      "shift_weight",
      "step_forward",
      "step_back",
      "stop",
      "draw_together",
    ],
  }),
  action: Object.freeze([
    "athena.core:action/approach",
    "athena.core:action/stop_current_activity",
    "athena.core:action/offer_comfort",
    "athena.core:action/turn_to",
  ]),
  voiceStyles: Object.freeze([
    "athena.core:voice_style/cool",
    "athena.core:voice_style/restrained",
    "athena.core:voice_style/soft",
    "athena.core:voice_style/firm",
    "athena.core:voice_style/urgent",
    "athena.core:voice_style/trembling",
  ]),
});

function faceCapabilityIds() {
  return Object.entries(CAPABILITIES.face).flatMap(([region, states]) =>
    states.map((state) => `athena.core:face_${region}/${state}`)
  );
}

function motionCapabilityIds() {
  return Object.entries(CAPABILITIES.motion).flatMap(([part, motions]) =>
    motions.map((motion) => `athena.core:${part}_motion/${motion}`)
  );
}

const ALL_CAPABILITY_IDS = Object.freeze([
  ...CAPABILITIES.emotions,
  ...faceCapabilityIds(),
  ...CAPABILITIES.gaze,
  ...motionCapabilityIds(),
  ...CAPABILITIES.action,
  ...CAPABILITIES.voiceStyles,
]);

function capabilityKind(id) {
  return String(id).split(":")[1]?.split("/")[0] || "extension";
}

function capabilityChannels(id) {
  const kind = capabilityKind(id);
  if (kind.startsWith("face_")) return ["face"];
  if (kind === "gaze") return ["gaze"];
  if (kind === "voice_style") return ["voice"];
  if (kind === "action") return ["world.interaction"];
  if (kind === "emotion") return ["face", "gaze", "body.upper", "voice"];
  return kind === "leg_motion" ? ["body.lower"] : ["body.upper"];
}

function capabilityDefinition(id) {
  const kind = capabilityKind(id);
  const parameters =
    kind === "action"
      ? {
          type: "object",
          properties: {
            purpose: { type: "string", maxLength: 160 },
            reason: { type: "string", maxLength: 160 },
            intent: { type: "string", maxLength: 160 },
            urgency: {
              type: "string",
              enum: ["low", "normal", "high"],
            },
          },
          additionalProperties: false,
        }
      : {
          type: "object",
          properties: {},
          additionalProperties: false,
        };
  return {
    id,
    kind,
    version: "2.0.0",
    available: true,
    channels: capabilityChannels(id),
    resource_claims: capabilityChannels(id).map(
      (channel) => `${channel}.primary`
    ),
    parameters,
    safety_class: kind === "action" ? "interaction" : "cosmetic",
    interruptibility: kind === "action" ? "at_boundary" : "blend_out",
    minimum_runtime_version: "2.0.0",
    timing: {
      minimum_duration_ms: kind === "gaze" ? 80 : 40,
      maximum_duration_ms: kind === "voice_style" ? 360000 : 30000,
      blendable: kind !== "action",
    },
    allowed_sides:
      kind.startsWith("face_") || kind.includes("motion")
        ? ["left", "right", "both", "center"]
        : ["center"],
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = canonicalize(value[key]);
      return result;
    }, {});
}

function manifestDigest(manifest) {
  const digestPayload = {
    ...manifest,
    integrity: {
      ...(manifest.integrity || {}),
      sha256: undefined,
    },
  };
  delete digestPayload.integrity.sha256;
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(digestPayload)))
    .digest("hex");
}

const MANIFEST_BASE = {
  schema: MANIFEST_OBJECT,
  schema_version: PROTOCOL_VERSION,
  id: "athena.cold_tsundere.expressive",
  version: "2.0.0",
  namespace: "athena.core",
  character_id: "athena.test.cold_tsundere",
  performance_profile: PERFORMANCE_PROFILE,
  minimum_runtime_version: "2.0.0",
  face_regions: FACE_REGIONS,
  track_order: [
    "face",
    "gaze",
    "head_neck",
    "shoulders",
    "torso",
    "left_arm",
    "right_arm",
    "left_hand",
    "right_hand",
    "left_leg",
    "right_leg",
    "action",
    "speech",
  ],
  capabilities: ALL_CAPABILITY_IDS.map(capabilityDefinition),
  fallbacks: {},
  fallback_policy: {
    unknown_optional: "warn",
    unknown_required: "reject",
    max_depth: 4,
  },
  permissions: {
    default: "deny",
    requested: [],
    denied_data_domains: [
      "athena_core",
      "user_memory",
      "files",
      "browser",
      "finance",
      "api_keys",
      "private_tools",
    ],
  },
  integrity: {
    signature_algorithm: "none",
  },
};

const MANIFEST_SHA256 = manifestDigest(MANIFEST_BASE);
const MANIFEST_REF = Object.freeze({
  id: MANIFEST_BASE.id,
  version: MANIFEST_BASE.version,
  sha256: MANIFEST_SHA256,
});
const MANIFEST = Object.freeze({
  ...MANIFEST_BASE,
  integrity: {
    ...MANIFEST_BASE.integrity,
    sha256: MANIFEST_SHA256,
  },
});

const PROFILE = Object.freeze({
  id: PERFORMANCE_PROFILE,
  characterId: "athena.test.cold_tsundere",
  manifestRef: MANIFEST_REF,
  manifest: MANIFEST,
  persona: [
    "成年女性角色，外表高冷、克制、从容，内在关心用户但不轻易承认。",
    "表演采用高细节密度、低动作幅度：眉眼、眼睑、嘴唇、下颌与细微头身动作丰富，但避免夸张卡通动作。",
    "傲娇允许嘴硬、反问和回避直接示爱；危险场景安全优先，必须立即停止含蓄表达并明确求助。",
  ].join(""),
  allCapabilityIds: ALL_CAPABILITY_IDS,
});

function resolveProfile(characterId, performanceProfile) {
  return characterId === PROFILE.characterId &&
    performanceProfile === PROFILE.id
    ? PROFILE
    : null;
}

module.exports = {
  ALL_CAPABILITY_IDS,
  CAPABILITIES,
  MANIFEST,
  MANIFEST_REF,
  PROFILE,
  manifestDigest,
  resolveProfile,
};
