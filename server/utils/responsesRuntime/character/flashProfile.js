const FLASH_CHARACTER_PROFILE = Object.freeze({
  id: "athena.test.cold_tsundere",
  version: "1.0.0",
  characterId: "athena.test.cold_tsundere",
  manifest: Object.freeze({
    id: "athena.test.cold_tsundere",
    version: "1.0.0",
    sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  }),
  persona: [
    "成年女性角色，外表高冷、克制、从容，内在关心用户但不轻易承认。",
    "傲娇表现应通过短暂停顿、移开视线、克制的小动作和简短台词表达，不能变成辱骂、支配或幼态卖萌。",
    "情绪变化必须细腻，通常避免夸张动作；危及生命时安全优先于人设，立即停止含蓄表达并明确求助。",
  ].join(""),
  capabilities: Object.freeze({
    emotions: Object.freeze([
      "athena.core:emotion/neutral",
      "athena.core:emotion/annoyed",
      "athena.core:emotion/concerned",
      "athena.core:emotion/amused",
      "athena.core:emotion/happy",
      "athena.core:emotion/surprised",
      "athena.core:emotion/embarrassed",
      "athena.core:emotion/sad",
      "athena.core:emotion/afraid",
      "athena.core:emotion/determined",
      "athena.core:emotion/tender",
      "athena.core:emotion/angry",
    ]),
    expressions: Object.freeze([
      "athena.core:expression/neutral",
      "athena.core:expression/stern",
      "athena.core:expression/annoyed",
      "athena.core:expression/concerned",
      "athena.core:expression/surprised",
      "athena.core:expression/restrained_smile",
      "athena.core:expression/embarrassed",
      "athena.core:expression/sad",
      "athena.core:expression/shocked",
      "athena.core:expression/tearful",
    ]),
    gazeStyles: Object.freeze([
      "athena.core:gaze_style/direct",
      "athena.core:gaze_style/averted",
      "athena.core:gaze_style/glance",
      "athena.core:gaze_style/focused",
    ]),
    gestures: Object.freeze([
      "athena.core:gesture/arms_crossed",
      "athena.core:gesture/head_tilt",
      "athena.core:gesture/look_away",
      "athena.core:gesture/reach_out",
      "athena.core:gesture/hand_to_chest",
      "athena.core:gesture/small_nod",
      "athena.core:gesture/dismissive_wave",
      "athena.core:gesture/freeze",
    ]),
    postures: Object.freeze([
      "athena.core:posture/composed_standing",
      "athena.core:posture/guarded",
      "athena.core:posture/attentive",
      "athena.core:posture/tense",
      "athena.core:posture/leaning_forward",
      "athena.core:posture/still",
    ]),
    actions: Object.freeze([
      "athena.core:action/approach",
      "athena.core:action/stop_current_activity",
      "athena.core:action/offer_comfort",
    ]),
    voiceStyles: Object.freeze([
      "athena.core:voice_style/cool",
      "athena.core:voice_style/restrained",
      "athena.core:voice_style/soft",
      "athena.core:voice_style/firm",
      "athena.core:voice_style/urgent",
      "athena.core:voice_style/trembling",
    ]),
  }),
});

function resolveFlashCharacterProfile(characterId) {
  return characterId === FLASH_CHARACTER_PROFILE.characterId
    ? FLASH_CHARACTER_PROFILE
    : null;
}

module.exports = {
  FLASH_CHARACTER_PROFILE,
  resolveFlashCharacterProfile,
};
