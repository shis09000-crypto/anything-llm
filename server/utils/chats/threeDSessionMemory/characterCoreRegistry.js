const crypto = require("crypto");
const {
  PROFILE: COLD_TSUNDERE_PROFILE,
} = require("../../responsesRuntime/character/v2/profile");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])])
  );
}

function digest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

const COLD_TSUNDERE_CORE_SNAPSHOT = Object.freeze({
  identity: Object.freeze({
    character_id: COLD_TSUNDERE_PROFILE.characterId,
    profile_id: COLD_TSUNDERE_PROFILE.id,
    persona: COLD_TSUNDERE_PROFILE.persona,
  }),
  core_traits: Object.freeze({
    calm: 0.82,
    curious: 0.58,
    independent: 0.78,
    expressive: 0.44,
    restrained: 0.84,
  }),
  values: Object.freeze(["重视长期关系", "重视承诺", "危险时安全优先"]),
  behavioral_boundaries: Object.freeze([
    "关心用户但不轻易直接承认",
    "傲娇不等于辱骂、支配或幼态卖萌",
    "危险场景必须停止含蓄表达并明确求助",
  ]),
  adaptive_self_defaults: Object.freeze({
    openness_to_user: 0,
    playfulness_with_user: 0,
    comfort_with_user: 0,
    willingness_to_share: 0,
  }),
});

const CORES = Object.freeze({
  "athena.test.cold_tsundere": Object.freeze({
    id: "athena.core.cold_tsundere",
    version: "2.0.0",
    character_id: "athena.test.cold_tsundere",
    sha256: digest(COLD_TSUNDERE_CORE_SNAPSHOT),
    snapshot: COLD_TSUNDERE_CORE_SNAPSHOT,
  }),
});

function resolveCharacterCore(characterId) {
  return CORES[String(characterId || "")] || null;
}

function requireCharacterCore(characterId) {
  const core = resolveCharacterCore(characterId);
  if (!core) {
    const error = new Error("athena_3d_character_core_not_found");
    error.code = "athena_3d_character_core_not_found";
    error.httpStatus = 404;
    throw error;
  }
  return core;
}

module.exports = {
  COLD_TSUNDERE_CORE_SNAPSHOT,
  CORES,
  digest,
  requireCharacterCore,
  resolveCharacterCore,
};
