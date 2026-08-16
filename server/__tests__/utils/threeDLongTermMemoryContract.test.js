const {
  decayedEmotion,
  initialRelationship,
  validateConsolidation,
} = require("../../utils/chats/threeDSessionMemory/longTermContract");
const {
  MODEL,
  consolidationInstructions,
} = require("../../utils/chats/threeDSessionMemory/longTermModelClient");
const {
  BACKGROUND_MODEL,
  BACKGROUND_PROVIDER,
} = require("../../utils/chats/threeDSessionMemory/modelClient");

function payload() {
  return {
    object: "athena.3d_center.character_memory",
    protocol_version: "1.0",
    conversation_memory: {
      summary: "妹妹考到年级十二，哥哥答应周末陪她去书店买新书。",
      topics: ["考试成绩", "新书奖励"],
      facts: [{ text: "年级第十二", turn_refs: [2] }],
      preferences: [{ text: "想要新书", turn_refs: [3] }],
      promises: [{ text: "周末陪她去书店", turn_refs: [4] }],
      open_threads: [{ text: "周末书店之行尚未完成", turn_refs: [4] }],
      important_turn_refs: [2, 4],
    },
    relationship_transition: {
      before: initialRelationship(),
      delta: {
        affection: 0.1,
        trust: 0.1,
        closeness: 0.08,
        comfort: 0.05,
        guardedness: 0.05,
      },
      after: {
        affection: 0.1,
        trust: 0.1,
        closeness: 0.08,
        comfort: 0.05,
        guardedness: 0.05,
      },
      narrative: "嘴硬但明显更信任哥哥。",
      confidence: 0.9,
    },
    final_emotion: {
      primary: "proud",
      secondary: "shy",
      intensity: 0.6,
      valence: 0.7,
      arousal: 0.35,
      attitude_toward_user: "亲近但傲娇",
      unresolved_feelings: ["期待周末奖励"],
      persistence: "short",
    },
    state_interpretation: {
      facial_signal: "压住笑意",
      gaze_signal: "短暂移开视线",
      body_signal: "姿态放松",
      action_signal: "没有持续动作",
      social_meaning: "接受关心但仍维持嘴硬外壳",
      evidence_paths: ["authoritative_final_state.face"],
    },
  };
}

describe("Athena 3D long-term character memory contract", () => {
  test("accepts mathematically consistent relationship state with real turn evidence", () => {
    expect(
      validateConsolidation(payload(), initialRelationship(), [1, 2, 3, 4])
    ).toEqual(expect.objectContaining({ ok: true }));
  });

  test("rejects hallucinated turn references and inconsistent relationship math", () => {
    const invalidEvidence = payload();
    invalidEvidence.conversation_memory.facts[0].turn_refs = [99];
    expect(
      validateConsolidation(invalidEvidence, initialRelationship(), [1, 2])
    ).toEqual(
      expect.objectContaining({
        ok: false,
        code: "athena_3d_long_term_memory_evidence_invalid",
      })
    );
    const invalidMath = payload();
    invalidMath.relationship_transition.after.trust = 0.5;
    expect(
      validateConsolidation(invalidMath, initialRelationship(), [1, 2, 3, 4])
    ).toEqual(
      expect.objectContaining({
        ok: false,
        code: "athena_3d_long_term_relationship_math_invalid",
      })
    );
  });

  test("decays emotional continuity but never the relationship profile", () => {
    const observed = Date.now() - 6 * 60 * 60 * 1000;
    const decayed = decayedEmotion({
      ...payload().final_emotion,
      observed_at: observed,
    });
    expect(decayed.intensity).toBeCloseTo(0.3, 2);
    expect(decayed.decay_factor).toBeCloseTo(0.5, 2);
  });

  test("pins both compaction and consolidation background processing to DeepSeek Flash JSON", () => {
    expect(BACKGROUND_PROVIDER).toBe("deepseek");
    expect(BACKGROUND_MODEL).toBe("deepseek-v4-flash");
    expect(MODEL).toBe("deepseek-v4-flash");
    expect(consolidationInstructions()).toMatch(/JSON object/);
  });
});
